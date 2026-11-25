/**
 * A page that prints the calendar an app function builds, where the function
 * counts its days with a second function that calls itself. The proof that a
 * callee only reads must follow the recursion without refusing it, and the
 * links the function writes (`<app address>view-embed/Page?x=1`) must reach
 * the page's own route. The checks run the generated page module.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { buildUi, generateUi } from '../src/index.js';
import { ADMIN, invoke, liveDatastore, loadTree } from './page-endpoint.js';

const SNIPPET_TODO = 'Server-side Deluge snippet requires manual translation';
const span = { start: 0, end: 0 };

const LISTING = `//Generating the list here
if(input.num > 0)
{
	mylist.add(num);
	thisapp.PageData.listing(num - 1,mylist);
}
return mylist.sort(true);`;

const CALENDAR = `endDate = eomonth(userdate,0);
StartDate = toStartOfMonth(userdate);
month_of_year = {"1":"January","2":"February","3":"March","4":"April","5":"May","6":"June","7":"July","8":"August","9":"September","10":"October","11":"November","12":"December"};
monthVal = userdate.getMonth();
prev = StartDate.subDay(1);
next = endDate.addDay(1);
dateList = thisapp.PageData.listing(endDate.getDay(),{});
if(StartDate.getDayOfWeek() > 1)
{
	zeroList = thisapp.PageData.listing(StartDate.getDayOfWeek() - 1,{});
	for each  eachZeroList in zeroList
	{
		dateList.add(0);
	}
}
dateList.sort(true);
if(7 - endDate.getDayOfWeek() < 7)
{
	endDayOfWeek = 7 - endDate.getDayOfWeek();
	zeroList = thisapp.PageData.listing(endDayOfWeek,{});
	for each  eachZeroList in zeroList
	{
		dateList.add(0);
	}
}
str = "<table class='caltable'><tr><th class='caltableHeading'><a href='" + zoho.appuri + "view-embed/Cal?dateVal=" + prev + "&&usermailid=" + usermailid + "' target='CalendarView'><</a></th><th colspan='5'>" + month_of_year.get(monthVal.toString()) + " " + userdate.getYear() + "</th><th><a href='" + zoho.appuri + "view-embed/Cal?dateVal=" + next + "&&usermailid=" + usermailid + "' target='CalendarView'>></a></th></tr>";
for each index eachIndexOfDate in dateList
{
	indexVal = eachIndexOfDate + 1;
	val = dateList.get(eachIndexOfDate);
	if(indexVal % 7 == 1)
	{
		str = str + "<tr>";
	}
	if(val == "0")
	{
		str = str + "<td class='caltableCell'></td>";
	}
	else
	{
		str = str + "<td class='caltableCell'><a href='" + zoho.appuri + "view-embed/DayChart?dayVal=" + prev.addDay(val.toLong()) + "&&userMailID=" + usermailid + "' target='DateView'>" + val + "</a></td>";
	}
	if(indexVal % 7 == 0)
	{
		str = str + "</tr>";
	}
}
str = str + "</table>";
return str;`;

function appWith(fns: { name: string; signature: string; deluge: string }[], snippet: string): App {
  const zml = `<zml><layout><row><column width='100%'><dsp id='Cal1'><![CDATA[${snippet}]]></dsp></column></row></layout></zml>`;
  const app = deriveIr(parse(`application "Demo"
{
	section Front
	{
form Notes
{
  Body
  (
    type = text
  )
}
		page Cal(dateVal, usermailid)
		{
			Content=${JSON.stringify(zml)}
		}
		page DayChart(dayVal, userMailID)
		{
			Content=${JSON.stringify("<zml><layout><panel><text value='day'/></panel></layout></zml>")}
		}
	}
}
`));
  app.profiles.push({ name: 'Administrator', type: 'Users_Permissions', properties: [], modules: [], span });
  for (const fn of fns) app.functions.push({ name: fn.name, kind: 'deluge', signature: fn.signature, deluge: [{ text: fn.deluge, span }], properties: [], span });
  return app;
}

const FUNCTIONS = [
  { name: 'PageData.calendarFun', signature: 'string PageData.calendarFun(date userdate, string usermailid)', deluge: CALENDAR },
  { name: 'PageData.listing', signature: 'list PageData.listing(int num, list mylist)', deluge: LISTING },
];

const PAGE = `htmlpage Cal1()
content
<%{
	userdate = input.dateVal.toDate();
	str = thisapp.PageData.calendarFun(userdate,input.usermailid);
	%>
<style>.caltable{width:100%}</style>
<%=str%>
<%
}%>`;

test('a function that counts through a call to itself still proves read-only and the calendar page compiles', () => {
  const { model } = buildUi(appWith(FUNCTIONS, PAGE));
  assert.deepEqual(model.todos.filter((todo) => todo.reason === SNIPPET_TODO), []);
});

test('the calendar page prints the month, every day once, and links that reach the page routes', async () => {
  const { files, model } = generateUi(appWith(FUNCTIONS, PAGE));
  assert.deepEqual(model.todos.filter((todo) => todo.reason === SNIPPET_TODO), []);
  const dir = loadTree(files);
  const live = liveDatastore();
  const page = await invoke(dir, 'functions/htmlpages/cal-s0.mjs', ADMIN, { input: { dateVal: '2026-03-15', usermailid: 'a-mail' } }).finally(live.restore);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  const html = String(page.body.html);
  assert.match(html, /March 2026/);
  assert.equal(html.match(/<tr>/g)?.length, 6, 'a title row and five weeks');
  const days = [...html.matchAll(/href="#\/page\/DayChart\?dayVal=(\d{2}-[A-Za-z]{3}-\d{4})&amp;userMailID=a-mail">(\d+)<\/a>/g)];
  assert.equal(days.length, 31);
  assert.deepEqual(days.map((day) => day[2]), Array.from({ length: 31 }, (_, index) => String(index + 1)));
  assert.equal(days[0]![1], '01-Mar-2026');
  assert.equal(days[30]![1], '31-Mar-2026');
  assert.match(html, /href="#\/page\/Cal\?dateVal=28-Feb-2026&amp;usermailid=a-mail">&lt;<\/a>/);
  assert.match(html, /href="#\/page\/Cal\?dateVal=01-Apr-2026&amp;usermailid=a-mail">&gt;<\/a>/);
  // March 2026 starts on a Sunday and ends on a Tuesday: four empty cells close the last week.
  assert.equal(html.match(/<td class="caltableCell"><\/td>/g)?.length, 4);
  assert.deepEqual(page.body.notes, []);
});

test('the same calendar starts a week later when the month starts on another day', async () => {
  const { files } = generateUi(appWith(FUNCTIONS, PAGE));
  const dir = loadTree(files);
  const live = liveDatastore();
  const page = await invoke(dir, 'functions/htmlpages/cal-s0.mjs', ADMIN, { input: { dateVal: '2026-05-10', usermailid: 'a-mail' } }).finally(live.restore);
  const html = String(page.body.html);
  assert.match(html, /May 2026/);
  // May 2026 starts on a Friday: five empty cells open the first week.
  const firstWeek = html.split('<tr>')[2] ?? '';
  assert.equal(firstWeek.match(/<td class="caltableCell"><\/td>/g)?.length, 5);
  assert.equal([...html.matchAll(/dayVal=/g)].length, 31);
});

test('a recursive function that writes keeps the page counted', () => {
  const writer = {
    name: 'PageData.stamp',
    signature: 'string PageData.stamp(int num)',
    deluge: 'if(input.num > 0)\n{\n\tinsert into Notes\n\t[\n\t\tBody="x"\n\t]\n\tthisapp.PageData.stamp(num - 1);\n}\nreturn "done";',
  };
  const page = `htmlpage Cal1()\ncontent\n<%{\n\tstr = thisapp.PageData.stamp(3);\n%>\n<p><%=str%></p>\n<% }%>`;
  const { model } = buildUi(appWith([writer], page));
  assert.equal(model.todos.filter((todo) => todo.reason === SNIPPET_TODO).length, 1);
});
