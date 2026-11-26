/**
 * Words the UI and translator reason sentences are built from (the static text of the
 * reason and manual-step templates in `packages/ui/src/{model,pages,htmlpage,snippet-guidance}.ts`, the
 * report wording and the Deluge translator, plus the Creator system record columns). An app identifier that equals one of
 * these (a form called `Report`, a field called `target`) is not redacted by the name-aware layer
 * of `publicConstruct`: replacing every such word would rewrite the public sentence itself and
 * merge or garble the buckets. Such a name still leaves only a word the public sentences already
 * contain, and the slot-based rules (`Field <name>`, `Report <name>`, quoted names) still redact it
 * where the sentence names it. A word missing here only makes redaction stricter.
 */
const WORDS = `
declaration declarations
a accept accepting accepts access action add added_location added_time added_user added_user_ip_address address after
against ahead allowed an and any anywhere api app apply approval approver are arguments as aspect at attachment
attribute audio automatically back barcode because before binding block blueprint bound box branch browser built but
button by byte call called caller camera can cannot cap carried carry catalyst category character chart choose chosen
click clickable clicked clicking client code collection column complex component compute computed condition
conditional configure confirm connected connection console control controls correct correctly count counter creates
creator criteria criterion crop css currency custom customlayouts cutover data decimal default defaults deluge device
digits disable display displays does draw drop dropped drops duplicate duration dynamic e each edit editor effect
element empty enabling encryption endpoint enforce enforces equivalent event every exist explicitly expr expression
field fields file files filled filter filterable filters first flagged flat for form format fraction from function g
gateway generated generates generator grid grouping groups hand handler hands has hh hide hold hours id identifier if
iframe image in input inside intentionally into invalid is it its itself javascript keep kind last latitude leave
length lenses level limit link linked links list lists literal live load loads logic longer longitude look looks
lookup loss make malformed manual manually map mark markup masking maximum met method migrate migrated minutes missing
mm model modified_location modified_time modified_user modified_user_ip_address more multiple named names native
navigation needed neither nested never new no nor not note null number numeric object of off offers on once one only
op open opens openurl operator option options or order ordering original other over own owner page pair parameter
parameters parent part partner payload payments per phase photo picker pins places plain plot plus pointing policy
populate pre precision prefetch preview primary privacy property proportions protection prove pseudo qr query ratio
read reads rebuild rebuilt reclinkid reconfigure record record_status recorder recording recordings records recreate
reference references regardless regenerate reimplement rejection related render repeat replace report reporting
reports requests resize restriction result returns reverse route routes row rowid rows rule runs s safely same
sanitizer scanner scans schema scope scoped script search searchable second secondary seconds segment selecting
sendmail server set sets setting settings shape shim should show shown shows side silent single sits snippet so sort
source ss stage standing start starts statement static status stay stays step stop stored style subform submit success
summary supported taking taps target task template test text than that the them then there these this time timer to
todo tool toolbar transition translate translated translation trigger trim turned two u ui unchanged under underlying
unknown unrecognized unsupported untranslated up upload uploads url urls user validation value values verify video
view viewlinkname way weekdays when window wire wired with without workflow writes your zc zml
`;

export const PUBLIC_WORDS: ReadonlySet<string> = new Set(WORDS.split(/\s+/).filter(Boolean));
