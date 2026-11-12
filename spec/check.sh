#!/bin/sh
# Model-check the lifecycle. Needs Java and tla2tools.jar (TLA_JAR).
# Expect: TRUE config fails NoLostNotice (naive design); FALSE config passes.
cd "$(dirname "$0")"
JAR="${TLA_JAR:-tla2tools.jar}"
java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -config Transfer_FALSE.cfg -workers auto -metadir /tmp/tlc-transfer Transfer.tla | grep -E "No error|Error|violated"
