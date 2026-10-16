import { LIGHT, tokensCss } from './tokens.js';

/**
 * Base styling for generated Slate apps. One stylesheet for every generated
 * app: the design tokens from tokens.ts, then the app shell (top bar, menu,
 * content card), forms, report tables, request states, toasts, and the
 * accessible defaults (visible focus, label pairing hooks, reduced motion).
 *
 * Rules below read colours, shadows, font stacks and type sizes only through
 * the `--c2c-*` custom properties, so a theme palette or the dark scheme
 * re-skins every component by overriding tokens alone.
 */
/** The shell page background token — also the web manifest `background_color`. */
export const SHELL_BACKGROUND = LIGHT.bg;
export const BASE_CSS = `${tokensCss()}html[data-font="lato"] body{font-family:var(--c2c-font-family-lato)}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;font:var(--c2c-font-size-base)/var(--c2c-line) var(--c2c-font-family);color:var(--c2c-ink);background:var(--c2c-bg)}
h1{font-size:var(--c2c-font-size-xl);line-height:var(--c2c-line-tight);margin:0 0 var(--c2c-space-4)}
h2{font-size:var(--c2c-font-size-l);line-height:var(--c2c-line-tight);margin:0 0 var(--c2c-space-3)}
h3{font-size:var(--c2c-font-size-m);margin:var(--c2c-space-4) 0 var(--c2c-space-2)}
:focus-visible{outline:var(--c2c-focus-width) solid var(--c2c-accent);outline-offset:2px;border-radius:var(--c2c-radius-s)}
.skip{position:absolute;left:var(--c2c-space-3);top:-4rem;background:var(--c2c-accent);color:var(--c2c-accent-ink);padding:var(--c2c-space-2) var(--c2c-space-4);border-radius:var(--c2c-radius-s);z-index:60;text-decoration:none}
.skip:focus{top:var(--c2c-space-2)}
.topbar{display:flex;align-items:center;gap:var(--c2c-space-3);background:var(--c2c-topbar-bg);color:var(--c2c-topbar-ink);padding:var(--c2c-space-3) var(--c2c-space-4);border-bottom:1px solid var(--c2c-border)}
.topbar #app-title{font-size:var(--c2c-font-size-l);font-weight:700;flex:1}
.topbar button{background:transparent;color:var(--c2c-topbar-ink);border:1px solid currentColor;border-radius:var(--c2c-radius-s);padding:var(--c2c-space-1) var(--c2c-space-3);cursor:pointer;font:inherit}
#menu-toggle{display:inline-block}
#tabbar{display:none}
#nav[data-collapsed="true"]{display:none}
#more-sheet{position:fixed;inset:0;z-index:60;background:var(--c2c-bg);overflow:auto;padding:var(--c2c-space-5) var(--c2c-space-4) var(--c2c-space-6)}
[data-more-head]{display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--c2c-space-4)}
[data-more-head] strong{font-size:var(--c2c-font-size-l)}
#more-sheet section{margin-bottom:var(--c2c-space-4)}
#more-sheet h2{font-size:var(--c2c-font-size-m)}
#more-sheet section a{display:block;background:var(--c2c-surface);border:1px solid var(--c2c-border);border-bottom-width:0;padding:var(--c2c-space-3) var(--c2c-space-4);color:var(--c2c-ink);text-decoration:none}
#more-sheet section a:first-of-type{border-top-left-radius:var(--c2c-radius-m);border-top-right-radius:var(--c2c-radius-m)}
#more-sheet section a:last-child{border-bottom-width:1px;border-bottom-left-radius:var(--c2c-radius-m);border-bottom-right-radius:var(--c2c-radius-m)}
#more-sheet section a[aria-current="page"]{font-weight:700;color:var(--c2c-accent)}
.shell{display:flex;align-items:stretch;min-height:calc(100vh - 3.5rem)}
#nav{width:var(--c2c-menu-width);flex:none;background:var(--c2c-menu-bg);border-right:1px solid var(--c2c-border);padding:var(--c2c-space-4);color:var(--c2c-menu-ink)}
#nav .apptile{display:flex;align-items:center;justify-content:center;width:2.75rem;height:2.75rem;border-radius:var(--c2c-radius-m);background:var(--c2c-menu-head);color:var(--c2c-accent-ink);margin-bottom:var(--c2c-space-4)}
#nav .navhead{display:flex;align-items:center;gap:var(--c2c-space-3);margin-bottom:var(--c2c-space-4)}
#nav .navhead .apptile{margin-bottom:0}
#nav .navapp{color:var(--c2c-menu-active-ink);font-size:var(--c2c-font-size-l);font-weight:700;line-height:var(--c2c-line-tight)}
#nav .zicon{display:inline-flex;flex:none}
#nav details,#nav [data-section]{margin-bottom:var(--c2c-space-2)}
#nav .navsec>summary,#nav summary,#nav [data-section]>strong{display:flex;align-items:center;gap:var(--c2c-space-2);font-weight:700;cursor:pointer;padding:var(--c2c-space-2) var(--c2c-space-3);border-radius:var(--c2c-radius-s);color:var(--c2c-menu-ink)}
#nav .navitem,#nav a,#nav span{display:flex;align-items:center;gap:var(--c2c-space-2);color:var(--c2c-menu-ink);padding:var(--c2c-space-2) var(--c2c-space-3);border-radius:var(--c2c-radius-s);text-decoration:none}
[data-zml="row"]{display:flex;flex-wrap:wrap;align-items:flex-start;gap:var(--c2c-space-4)}
[data-zml="column"]{box-sizing:border-box;min-width:0;flex:1}
[data-zml="panel"]{border:1px solid var(--c2c-border);border-radius:var(--c2c-radius-m);padding:var(--c2c-space-3);background:var(--c2c-surface)}
[data-zml="pr"]{display:flex;flex-wrap:wrap;align-items:center;gap:var(--c2c-space-2)}
.zicon{display:inline-flex;align-items:center;justify-content:center;font-size:var(--c2c-font-size-icon)}
.zicon svg{width:1em;height:1em}
.zcard{display:block;color:inherit;text-decoration:none}
.kpi{display:block;font-size:var(--c2c-font-size-xl);font-weight:700;color:var(--c2c-primary)}
.modal{position:fixed;inset:0;z-index:60;display:flex;align-items:flex-start;justify-content:center;padding:var(--c2c-space-5) var(--c2c-space-3);background:var(--c2c-scrim);overflow:auto}
.modal-card{position:relative;box-sizing:border-box;width:min(560px,100%);background:var(--c2c-surface);border:1px solid var(--c2c-border);border-radius:var(--c2c-radius-m);padding:var(--c2c-space-4);box-shadow:var(--c2c-shadow-l)}
.modal-card .card{border:0;padding:0;box-shadow:none}
.modal-close{position:absolute;top:var(--c2c-space-2);right:var(--c2c-space-3);border:0;background:transparent;font-size:var(--c2c-font-size-close);line-height:1;cursor:pointer;color:inherit;padding:var(--c2c-space-1) var(--c2c-space-2)}
.embed h3{margin:var(--c2c-space-2) 0}
#nav a:hover{background:var(--c2c-menu-active-bg);color:var(--c2c-menu-active-ink)}
#nav a[aria-current="page"]{font-weight:700;background:var(--c2c-menu-active-bg);color:var(--c2c-menu-active-ink)}
#nav .navsec[data-active]>summary,#nav .navsec:has(a[aria-current="page"])>summary{background:var(--c2c-menu-active-bg);color:var(--c2c-menu-active-ink)}
html[data-menu="rail"] #nav{width:5.75rem;padding:var(--c2c-space-3) var(--c2c-space-1)}
html[data-menu="rail"] #nav .apptile{margin:0 auto var(--c2c-space-3)}
html[data-menu="rail"] #nav .navsec{position:relative;margin:0 0 var(--c2c-space-1)}
html[data-menu="rail"] #nav .navsec>summary{flex-direction:column;gap:4px;padding:var(--c2c-space-2) 2px;text-align:center;font-size:var(--c2c-font-size-xs);font-weight:600;list-style:none}
html[data-menu="rail"] #nav .navsec>summary::-webkit-details-marker{display:none}
html[data-menu="rail"] #nav .navitems{position:absolute;left:100%;top:0;min-width:11rem;z-index:30;background:var(--c2c-menu-bg);border-radius:var(--c2c-radius-s);box-shadow:var(--c2c-shadow-m);padding:var(--c2c-space-2)}
html[data-menu="rail"] #nav .navitem{font-size:var(--c2c-font-size-xs2)}
#main{flex:1;min-width:0;padding:var(--c2c-space-5)}
.card{background:var(--c2c-surface);border:1px solid var(--c2c-border);border-radius:var(--c2c-radius-m);box-shadow:var(--c2c-shadow-s);padding:var(--c2c-space-5);max-width:72rem}
.form-grid{display:grid;grid-template-columns:1fr;gap:var(--c2c-space-4) var(--c2c-space-5)}
.field[data-label-placement="left"]{flex-direction:row;align-items:flex-start;gap:var(--c2c-space-3)}
.field[data-label-placement="left"]>label{flex:0 0 11rem;padding-top:0.6rem}
.field[data-height] textarea{min-height:var(--c2c-field-height,6rem)}
@media (min-width:769px){
[data-layout="two"] .form-grid{grid-template-columns:1fr 1fr}
[data-layout="three"] .form-grid{grid-template-columns:1fr 1fr 1fr}
[data-layout="two"] [data-column="1"]:not([data-span="all"]){grid-column:1}
[data-layout="two"] [data-column="2"]:not([data-span="all"]){grid-column:2}
[data-layout="three"] [data-column="1"]:not([data-span="all"]){grid-column:1}
[data-layout="three"] [data-column="2"]:not([data-span="all"]){grid-column:2}
[data-layout="three"] [data-column="3"]:not([data-span="all"]){grid-column:3}
[data-span="all"],[data-column="0"]{grid-column:1/-1}
}
.field{display:flex;flex-direction:column;gap:var(--c2c-space-1);margin:0;min-width:0}
.field>label,.field-title,.field legend{font-weight:400}
.field>fieldset{border:0;margin:0;padding:0;min-width:0}
.req{color:var(--c2c-danger);margin-left:var(--c2c-space-1)}
.field>small{color:var(--c2c-muted);font-size:var(--c2c-font-size-s)}
input:not([type="checkbox"]):not([type="radio"]),select,textarea{width:100%;min-height:var(--c2c-input-height);font:inherit;color:var(--c2c-ink);background:var(--c2c-surface);border:1px solid var(--c2c-border);border-radius:var(--c2c-radius-s);padding:var(--c2c-space-2) var(--c2c-space-3)}
textarea{min-height:calc(var(--c2c-input-height)*2);resize:none}
.field>input:not([type="checkbox"]):not([type="radio"]):not([type="file"]),.field>select,.field>textarea{max-width:var(--c2c-field-w)}
.c2c-lookup-search{display:block;margin-bottom:var(--c2c-space-1)}
.field .field input:not([type="checkbox"]):not([type="radio"]):not([type="file"]),.field .field select,.field .field textarea{max-width:var(--c2c-field-w)}
.field>.money{max-width:var(--c2c-field-w)}
.visually-hidden{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.money{display:flex;align-items:stretch;max-width:var(--c2c-field-w)}
.money>input{flex:1;min-width:0;border-right:0;border-radius:var(--c2c-radius-s) 0 0 var(--c2c-radius-s)}
.money>.money-sym{display:flex;align-items:center;padding:0 var(--c2c-space-3);border:1px solid var(--c2c-border);border-radius:0 var(--c2c-radius-s) var(--c2c-radius-s) 0;background:var(--c2c-tint);color:var(--c2c-muted)}
.filepick{display:inline-flex;align-items:center;gap:var(--c2c-space-3)}
.filepick-btn{display:inline-block;padding:var(--c2c-space-2) var(--c2c-space-4);border:1px solid var(--c2c-border);border-radius:var(--c2c-radius-s);background:var(--c2c-surface);cursor:pointer}
.filepick-name{color:var(--c2c-muted);font-size:var(--c2c-font-size-s)}
input[type="checkbox"],input[type="radio"]{width:1.125rem;height:1.125rem;accent-color:var(--c2c-accent)}
.choice{display:flex;align-items:center;gap:var(--c2c-space-2);font-weight:400}
button,.button-primary{font:inherit;min-height:var(--c2c-input-height);padding:var(--c2c-space-2) var(--c2c-space-4);border-radius:var(--c2c-radius-s);border:1px solid var(--c2c-accent);cursor:pointer;text-decoration:none;display:inline-block}
button[type="submit"],.button-primary{background:var(--c2c-primary);color:var(--c2c-accent-ink);border-color:var(--c2c-primary)}
button[type="button"]:not([data-action]):not([data-prev]):not([data-next]):not([data-retry]):not([data-add-row]){background:var(--c2c-surface);color:var(--c2c-ink)}
.error{color:var(--c2c-danger);min-height:1.2em;margin:0;font-size:var(--c2c-font-size-s)}
.todo{background:var(--c2c-warn-bg);padding:var(--c2c-space-2) var(--c2c-space-3);border-radius:var(--c2c-radius-s)}
.unavailable-note{color:var(--c2c-muted);margin:0}
.notes{color:var(--c2c-muted)}
[data-banner]:not(:empty){padding:var(--c2c-space-3);border-radius:var(--c2c-radius-s);background:var(--c2c-tint);margin:var(--c2c-space-4) 0}
.table-wrap{overflow-x:auto;margin:0 calc(var(--c2c-space-5) * -1);padding:0 var(--c2c-space-5)}
table{border-collapse:collapse;width:100%}
thead th{position:sticky;top:0;background:var(--c2c-tint);text-align:left;z-index:1}
td,th{border:1px solid var(--c2c-border);padding:var(--c2c-space-2) var(--c2c-space-3);text-align:left}
tbody tr:nth-child(even){background:var(--c2c-stripe)}
tbody tr:hover{background:var(--c2c-tint)}
[data-numeric="true"]{text-align:right;font-variant-numeric:tabular-nums}
tr[data-row]{cursor:pointer}
/* Creator stacks the search box and the Search button as two full-width blocks. */
[data-report-search]{display:block;margin-bottom:var(--c2c-space-3)}
[data-report-search] input{display:block;width:100%;box-sizing:border-box;margin-bottom:var(--c2c-space-2)}
[data-report-search] button{display:block;width:100%}
[data-pages]{display:flex;align-items:center;gap:var(--c2c-space-3);margin-top:var(--c2c-space-4)}
[data-pages] button{background:var(--c2c-surface);color:var(--c2c-ink);min-height:2.25rem}
[data-pages] button[disabled]{opacity:0.45;cursor:default}
[data-state]:empty{display:none}
[data-state]{padding:var(--c2c-space-4) 0}
.state-empty{text-align:center;padding:var(--c2c-space-6) 0}
.state-empty p{font-size:var(--c2c-font-size-l);margin:0 0 var(--c2c-space-4)}
.state-error{text-align:center;padding:var(--c2c-space-5) 0}
.skeleton{display:block;min-height:1rem;border-radius:var(--c2c-radius-s);background:var(--c2c-tint);margin:var(--c2c-space-2) 0;animation:c2c-pulse var(--c2c-motion-pulse) var(--c2c-ease-standard) infinite}
@keyframes c2c-pulse{50%{opacity:0.45}}
#toasts{position:fixed;bottom:var(--c2c-space-4);left:50%;transform:translateX(-50%);display:flex;flex-direction:column;gap:var(--c2c-space-2);z-index:50;max-width:min(28rem,calc(100vw - 2rem))}
.toast{background:var(--c2c-toast-bg);color:var(--c2c-on-strong);padding:var(--c2c-space-3) var(--c2c-space-4);border-radius:var(--c2c-radius-m);box-shadow:var(--c2c-shadow-m)}
.toast[data-kind="success"]{background:var(--c2c-success)}
.toast[data-kind="failure"]{background:var(--c2c-danger)}
#offline{background:var(--c2c-danger);color:var(--c2c-on-strong);margin:0;padding:var(--c2c-space-2) var(--c2c-space-4)}
#c2c-login{padding:0 var(--c2c-space-4);max-width:40rem}
#c2c-login [data-sign-in]{font-weight:600}
#c2c-login [data-sign-in-error]{color:var(--c2c-danger)}
#c2c-login [data-sign-in-hint]{color:var(--c2c-muted)}
[data-view="kanban"] [data-board]{display:flex;gap:var(--c2c-space-3);overflow:auto}
[data-lane]{min-width:14rem}
[data-lane] ul{margin:0;padding-left:1.2em}
canvas{border:1px solid var(--c2c-border);touch-action:none}
.subform table{margin-bottom:var(--c2c-space-2)}
/* Creator's subform add control is a centred accent link, not a pill button. */
.subform [data-add-row]{display:block;margin:0 auto;min-height:0;padding:0;border:0;border-radius:0;background:none;color:var(--c2c-accent);font-size:var(--c2c-font-size-s)}
.report-tools{display:flex;gap:var(--c2c-space-2);align-items:flex-start;flex-wrap:wrap;margin-bottom:var(--c2c-space-3)}
.report-tools [data-report-search]{width:100%;margin-bottom:var(--c2c-space-2)}
[data-chart-tools] button{background:var(--c2c-surface);color:var(--c2c-ink)}
[data-chart]{color:var(--c2c-muted)}
svg.chart{display:block;width:100%;max-width:40rem;height:auto}
.chart-tick{font-size:var(--c2c-font-size-2xs);fill:var(--c2c-muted)}
.chart-empty{color:var(--c2c-muted);text-align:center;padding:var(--c2c-space-6) var(--c2c-space-4);margin:0}
.chart-note{color:var(--c2c-muted);font-size:var(--c2c-font-size-2xs);margin:var(--c2c-space-2) 0 0}
/* A phone card field the list does not show. */
[data-report] td[data-phone-only]{display:none}
[data-board] [data-phone-fields]{display:none}
/* The phone card's record actions. Hidden until the card layout. */
[data-report] td[data-card-actions]{display:none}
@media (max-width:768px){
#menu-toggle{display:none}
.shell{min-height:0;display:block}
#nav{display:none}
#main{padding:var(--c2c-space-3);padding-bottom:calc(4.5rem + env(safe-area-inset-bottom, 0px))}
.card{padding:var(--c2c-space-4)}
.table-wrap{margin:0 calc(var(--c2c-space-4) * -1);padding:0 var(--c2c-space-4)}
#tabbar{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:40;background:var(--c2c-surface);border-top:1px solid var(--c2c-border);padding-bottom:env(safe-area-inset-bottom, 0px)}
#tabbar:empty{display:none}
#tabbar a,#tabbar button{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;gap:2px;background:transparent;border:0;border-top:2px solid transparent;color:var(--c2c-muted);padding:var(--c2c-space-2) var(--c2c-space-1);font:inherit;font-size:var(--c2c-font-size-s);cursor:pointer;text-decoration:none;text-align:center}
#tabbar svg{width:1.375rem;height:1.375rem;flex:none}
#tabbar .tab-label{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#tabbar [aria-current="page"]{color:var(--c2c-accent);border-top-color:var(--c2c-accent);font-weight:700}
#toasts{bottom:calc(4.5rem + env(safe-area-inset-bottom, 0px))}
[data-report] thead{display:none}
[data-report] table,[data-report] tbody{display:block}
[data-report] tr{display:block;background:var(--c2c-surface);border:1px solid var(--c2c-border);border-radius:var(--c2c-radius-m);box-shadow:var(--c2c-shadow-s);margin-bottom:var(--c2c-space-3)}
[data-report] tr[data-card]{display:flex;flex-direction:column}
[data-report] td{display:flex;gap:var(--c2c-space-3);align-items:baseline;border:0;border-bottom:1px solid var(--c2c-border);padding:var(--c2c-space-2) var(--c2c-space-3);text-align:left}
[data-report] td:last-child{border-bottom:0}
[data-report] td::before{content:attr(data-th);flex:none;max-width:45%;font-weight:600;color:var(--c2c-muted)}
[data-report] tr:not([data-card]) td:first-child,[data-report] td[data-phone="0"]{font-size:var(--c2c-font-size-l);font-weight:700}
[data-report] tr:not([data-card]) td:first-child::before,[data-report] td[data-phone="0"]::before{display:none}
[data-report] tr:not([data-card]) td:nth-child(n+5){display:none}
[data-report] tr[data-card] td:not([data-phone]){display:none}
[data-report] tr[data-card] td[data-phone]{display:flex}
[data-report] tr[data-card] td[data-card-actions]{display:block;order:9999}
[data-report] td[data-card-actions]::before{display:none}
[data-report] td[data-card-actions]>div{display:flex;flex-wrap:wrap;gap:var(--c2c-space-2)}
[data-report] td[data-card-actions] button,[data-report] td[data-card-actions] a{min-height:2.75rem;display:inline-flex;align-items:center}
[data-board] [data-phone-fields]{display:grid;grid-template-columns:auto 1fr;gap:0 var(--c2c-space-2);margin:var(--c2c-space-1) 0 0;font-size:var(--c2c-font-size-s)}
[data-board] [data-phone-fields] dt{color:var(--c2c-muted)}
[data-board] [data-phone-fields] dd{margin:0}
[data-report] td[data-numeric="true"]{text-align:left}
}
@media (prefers-reduced-motion:reduce){
*,*::before,*::after{animation:none;transition:none}
#nav{transition:none}
}
/* Record print sheet: an overlay on screen, the only page content on paper. */
[data-print-sheet]{position:fixed;inset:0;z-index:70;background:var(--c2c-bg);overflow:auto;padding:var(--c2c-space-5)}
[data-print-bar]{display:flex;align-items:center;gap:var(--c2c-space-3);max-width:48rem;margin:0 auto var(--c2c-space-4)}
[data-print-hint]{color:var(--c2c-muted);font-size:var(--c2c-font-size-s);margin:0}
[data-print-page]{background:var(--c2c-surface);color:var(--c2c-ink);max-width:48rem;margin:0 auto;padding:var(--c2c-space-6);box-shadow:var(--c2c-shadow-m)}
[data-print-columns]{display:flex;gap:var(--c2c-space-4)}
[data-print-col]{flex:1;min-width:0}
[data-print-field]{display:flex;gap:var(--c2c-space-3);margin:var(--c2c-space-1) 0}
[data-print-label]{flex:none;min-width:8rem;color:var(--c2c-muted)}
[data-print-lookup]{margin:var(--c2c-space-2) 0}
[data-print-lookup-label]{font-size:var(--c2c-font-size-m);margin:0 0 var(--c2c-space-2)}
[data-print-lookup] table{width:100%}
[data-print-image]{display:block;max-width:100%;margin:var(--c2c-space-2) auto}
[data-print-spacer]{min-height:1rem}
@media print{
body>*:not([data-print-sheet]){display:none!important}
[data-print-sheet]{position:static;overflow:visible;background:transparent;padding:0}
[data-print-bar]{display:none}
[data-print-page]{box-shadow:none;max-width:none;padding:0;background:transparent}
}
`;
