---
description: Root-cause a bug from symptom to verified fix — reproduce, isolate, hypothesize, fix at root
agent: debugger
---

Diagnose and fix:

$ARGUMENTS

Method: reproduce reliably first (exact steps; minimize) · read the FULL error/stack · isolate the failing layer by halving the pipeline · state ranked hypotheses with the cheapest test for each · bisect history if a known-good commit exists · fix at ROOT (why did invalid state arise?), not the symptom. Deliver: SYMPTOM → ROOT CAUSE → FIX → verification evidence (repro now passes) → sibling bugs of the same class checked.
