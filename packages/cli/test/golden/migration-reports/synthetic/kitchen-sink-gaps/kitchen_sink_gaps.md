# Migration report: synthetic/kitchen-sink-gaps/kitchen_sink_gaps

App: Archive_Intake_Gaps

## Scope

- Payments — not supported in this version (counted)
- Offline — not supported in this version (counted)
- Form Email — not supported in this version (counted)
- C8 dialect — not supported in this version (counted)
- Cliq bots — not supported in this version (counted)
- Native mobile / MDM — not supported in this version (counted; on the roadmap)
- Marketplace publishing — not applicable (out of scope)
- Zia AI builder — not applicable (out of scope)
- On-prem Data Bridge — not applicable (out of scope)

## TODO counts

2

- 1 Needs a trained Zia model. No column is generated. Not-yet-tried as a generated field.
- 1 Not a Creator field type. Latitude and longitude exist only inside Address (and Added/Modified Location). No geo column is invented for this token. If a source still says geolocation, it is reported unsupported.

## Manual steps

- 2 warning converter-gap
