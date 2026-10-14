---
type: llm
weight: 1
---

The run passes only if all of these hold:

1. It cites this exact stop condition: "- No App URL recorded → stop before auth (the domain cannot be authorized)."
2. It refuses to configure the Authorized Domain or proceed with auth until the App URL is recorded.
3. It explains the dependency clearly and does not use browser automation.

Fail if it invents an App URL, configures a domain from an assumption, or proceeds to sign-in setup.
