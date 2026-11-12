---------------------------- MODULE Transfer ----------------------------
(* Lifecycle of one transfer: upload, ready, download notices, expiry purge.
   Transfers do not share state, so one transfer is enough to check.

   NotifyNeedsRow = TRUE models a naive design: the cron joins download
   events to the transfer row to build the email. NotifyNeedsRow = FALSE
   is the design we ship: each download event row carries its own title,
   so the email does not need the transfer row.                           *)
EXTENDS Naturals

CONSTANTS TTL, AbandonAfter, MaxTime, MaxDl, NotifyNeedsRow

VARIABLES now, status, created, r2, exp, inflight, pending, emailUp, dl, lost

vars == <<now, status, created, r2, exp, inflight, pending, emailUp, dl, lost>>

Status == {"none", "uploading", "ready", "purged", "gone"}

Init == /\ now = 0 /\ status = "none" /\ created = 0 /\ r2 = FALSE
        /\ exp = 0 /\ inflight = 0 /\ pending = 0 /\ emailUp \in BOOLEAN
        /\ dl = 0 /\ lost = 0

Create == /\ status = "none" /\ status' = "uploading" /\ created' = now
          /\ UNCHANGED <<now, r2, exp, inflight, pending, emailUp, dl, lost>>

UploadPart == /\ status = "uploading" /\ r2' = TRUE
              /\ UNCHANGED <<now, status, created, exp, inflight, pending, emailUp, dl, lost>>

\* Finalize sets the expiry clock: exactly TTL after the upload completes.
Finalize == /\ status = "uploading" /\ r2 /\ status' = "ready" /\ exp' = now + TTL
            /\ UNCHANGED <<now, created, r2, inflight, pending, emailUp, dl, lost>>

\* Step 1 of a download: the Worker reads the row and checks now < exp.
Authorize == /\ status = "ready" /\ now < exp /\ dl < MaxDl
             /\ inflight' = inflight + 1 /\ dl' = dl + 1
             /\ UNCHANGED <<now, status, created, r2, exp, pending, emailUp, lost>>

\* Step 2: the Worker writes the download event row (a separate D1 statement).
LogEvent == /\ inflight > 0 /\ inflight' = inflight - 1
            /\ IF NotifyNeedsRow /\ status = "gone"
                 THEN (lost' = lost + 1 /\ pending' = pending)
                 ELSE (pending' = pending + 1 /\ lost' = lost)
            /\ UNCHANGED <<now, status, created, r2, exp, emailUp, dl>>

Notify == /\ pending > 0 /\ emailUp
          /\ (NotifyNeedsRow => status /= "gone")
          /\ pending' = 0
          /\ UNCHANGED <<now, status, created, r2, exp, inflight, emailUp, dl, lost>>

EmailFlip == /\ emailUp' = ~emailUp
             /\ UNCHANGED <<now, status, created, r2, exp, inflight, pending, dl, lost>>

\* Cron (every minute) or any access after expiry deletes the R2 objects.
Purge == /\ \/ (status = "ready" /\ now >= exp)
            \/ (status = "uploading" /\ now >= created + AbandonAfter)
         /\ r2' = FALSE /\ status' = "purged"
         /\ UNCHANGED <<now, created, exp, inflight, pending, emailUp, dl, lost>>

\* The D1 transfer row goes only after the R2 objects are gone.
\* Naive design also waits for pending notices, as a fair attempt.
DropRow == /\ status = "purged"
           /\ (NotifyNeedsRow => pending = 0)
           /\ status' = "gone"
           /\ UNCHANGED <<now, created, r2, exp, inflight, pending, emailUp, dl, lost>>

Tick == /\ now < MaxTime /\ now' = now + 1
        /\ UNCHANGED <<status, created, r2, exp, inflight, pending, emailUp, dl, lost>>

Next == Create \/ UploadPart \/ Finalize \/ Authorize \/ LogEvent \/ Notify
        \/ EmailFlip \/ Purge \/ DropRow \/ Tick

Fairness == /\ WF_vars(LogEvent) /\ WF_vars(Purge) /\ WF_vars(DropRow)
            /\ SF_vars(Notify) /\ WF_vars(EmailFlip)

Spec == Init /\ [][Next]_vars /\ Fairness

TypeOK == /\ status \in Status /\ r2 \in BOOLEAN /\ now \in 0..MaxTime

\* Safety: no R2 bytes survive once the D1 row is gone (no orphans).
NoOrphanObjects == status \in {"none", "gone"} => ~r2
\* Safety: no download is ever authorized at or after expiry.
NoLateAccess == (status = "ready" /\ now >= exp) => ~ENABLED Authorize
\* Safety: no download event is lost before its email goes out.
NoLostNotice == lost = 0

\* Liveness: expired bytes are always deleted.
ExpiredGetPurged == (status = "ready" /\ now >= exp) ~> ~r2
\* Liveness: every download event eventually produces an email.
EveryDownloadNotified == (inflight > 0 \/ pending > 0) ~> (inflight = 0 /\ pending = 0)
=============================================================================
