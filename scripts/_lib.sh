#!/usr/bin/env bash
# Shared picopi shell helpers — source, don't execute.
# Provides: $H (header glyph), $B/$G/$Y/$R/$D/$X (color codes),
#           ok(), warn(), fail() status printers.

# Color: respect NO_COLOR and non-tty stdout.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B='\033[1m'   # bold
  G='\033[32m'  # green
  Y='\033[33m'  # yellow
  R='\033[31m'  # red
  D='\033[2m'   # dim
  X='\033[0m'   # reset
else
  B='' G='' Y='' R='' D='' X=''
fi

H="${Y}⬡${X}"

ok()   { printf "  ${G}✓${X} %s\n" "$*"; }
warn() { printf "  ${Y}⚠${X} %s\n" "$*"; }
fail() { printf "  ${R}✗${X} %s\n" "$*"; }
