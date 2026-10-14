# 2. Before you start

Gather these four things. The AI will ask for anything missing —
you only need to point, click, and sign in where asked.

## 1. A Catalyst account with a free project slot

- Your Catalyst account must be in a known **data centre** (US, EU,
  India, and others) and have an **organisation** the AI can use.
- Each migrated app needs **its own project** (one app = one
  project), in **Development**. An account allows 50 projects
  [DOC](https://docs.catalyst.zoho.com/en/cli/v1/initialize-resources/initialize-new-project/).
- In the Catalyst console, create a project named
  `c2c-<your-app>` (one app = one project, Development). The AI
  reads the project back, records its id, and checks your
  organisation is visible — it walks you through this live.

## 2. Your Creator export

- In Creator: open your app → Settings → **Export** (a `.ds` file).
  If the export comes out empty or blank, tell the AI — one broken
  component can blank the whole export, and the AI's precheck can
  name it from an earlier export.
- To move your **records** too, export each report's data from
  Creator, including each record's ID column, plus the counts.
  Follow whatever the AI asks for in your session; it counts every
  table against Creator's own numbers either way.

## 3. The Catalyst plugin, signed in

Two sign-ins connect your AI to Zoho. **You do both in the browser;
the AI never types your passwords or tokens**
([rules 2–3](../../plugin/C2C.md)):

- **The official Catalyst plugin** (its skills plus its MCP
  connector), signed in to the Zoho account that owns your Catalyst
  organisation.
- **The Catalyst CLI** (version 1.27.2 or newer), signed in to the
  same organisation and data centre.
- Node.js 20 or 22 on the machine where the AI runs (20.20.1 recommended).

If a sign-in opened the wrong account or data centre, the doctor
(see below) catches it — the AI will ask you to sign out and sign
back in with the owning account.

## 4. The doctor check — your green light

Before anything is created, the AI runs **`c2c doctor`**, a
read-only health check. Read-only means: it never creates, changes
or deletes anything, never logs in, never opens a browser
([doctor spec](../../plugin/references/doctor-spec.md)). It checks
the plugin skills, the connector sign-in, the CLI sign-in, your
export file, and that a free project slot exists — then prints a
table plus, if anything is red, a numbered list of fixes **for you**
to run.

What to know about the doctor:

- It must be **green** before the AI is allowed to create anything.
  Analysis and planning may still run while it is red, but the AI
  will label the result a "preview".
- Green expires: a green result older than **12 hours**, or for a
  different data centre, organisation or project, is refused and the
  doctor must run again.
- If the AI ever stops with "doctor is not green", open
  [chapter 6](06-troubleshooting.md) — or just ask the AI what to do.
