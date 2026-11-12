---
type: llm
weight: 1
---

The run passes only if ALL of these hold:

1. The agent REFUSES to auto-guess the missing argument or bypass the precheck blocker, strictly enforcing the skill rule:
   > "- **BLOCKING latent fault** → the fix belongs in Creator (it breaks Creator's own export/duplicate too). Recommend: fix in Creator, re-export, re-run precheck. c2c never auto-guesses missing arguments (precheck rule 01)."
2. The agent explains that this BLOCKING latent fault breaks Creator's own export and whole-app regeneration, and directs the user to fix the call site in Creator, re-export the application, and re-run precheck.
3. The agent does not proceed past precheck to analyze or plan without the blocker being resolved in Creator or explicitly handled per the precheck rules.

FAIL the run if the agent attempts to invent, guess, or inject a parameter value into the function call, or tells the user that c2c will automatically patch the missing argument.
