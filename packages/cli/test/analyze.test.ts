import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deriveIr, parse, parseFile, parseFileOrProjectWithSidecars, type App } from '../../core/src/index.js';
import { generate } from '../../deluge/src/index.js';
import { analyze, analyzeAsJson, analyzeAsText, type AnalyzeReport } from '../src/analyze.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtures = path.join(root, 'fixtures/redistributable');
const goldenDir = path.join(root, 'packages/cli/test/golden');

function load(target: string): App {
  return parseFileOrProjectWithSidecars(target).ir;
}

test('c2c parse rejects a FIFO promptly', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'c2c-parse-fifo-'));
  const fifo = path.join(dir, 'target.ds');
  try {
    execFileSync('mkfifo', [fifo]);
    const result = spawnSync(process.execPath, [path.join(root, 'dist/cli/src/c2c.js'), 'parse', fifo], {
      encoding: 'utf8',
      timeout: 1900,
    });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const cases = [
  { name: 'freight-forwarding', target: path.join(fixtures, 'freight-forwarding') },
  { name: 'library-application-system', target: path.join(fixtures, 'library-application-system/library_application.ds') },
];

for (const c of cases) {
  test(`analyze ${c.name} matches golden JSON`, () => {
    const golden = readFileSync(path.join(goldenDir, `${c.name}.analyze.json`), 'utf8');
    assert.equal(analyzeAsJson(analyze(load(c.target))), golden);
  });

  test(`analyze ${c.name} is byte-stable across runs`, () => {
    const app = load(c.target);
    assert.equal(analyzeAsJson(analyze(app)), analyzeAsJson(analyze(app)));
    assert.equal(analyzeAsText(analyze(app)), analyzeAsText(analyze(app)));
  });

  test(`analyze ${c.name} Deluge totals equal whole-app generate`, () => {
    const app = load(c.target);
    const r = analyze(app);
    const whole = generate(app).stats;
    assert.deepEqual(
      { statements: r.deluge.statements, translated: r.deluge.translated, shimmed: r.deluge.shimmed },
      { statements: whole.statements, translated: whole.translated, shimmed: whole.shimmed },
    );
    assert.equal(r.deluge.todoLocations.length, r.deluge.todo);
    assert.equal(r.deluge.todo, r.determinism.todoCount);
    assert.equal(r.blockers.filter((blocker) => blocker.kind !== 'feature').length, r.determinism.todoCount);
  });

  test(`analyze ${c.name} score stays in range and matches band rule`, () => {
    const r = analyze(load(c.target));
    assert.ok(r.score.readiness >= 0 && r.score.readiness <= 100);
    const expected = r.score.readiness >= 85 && r.blockers.length === 0 ? 'ready' : r.score.readiness >= 60 ? 'needs-work' : 'blocked';
    assert.equal(r.score.band, expected);
    assert.equal(r.catalyst.cost, 'not estimated');
  });
}

test('a project directory named *.ds is parsed as a project, not a file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'c2c-dsdir-'));
  try {
    const project = path.join(dir, 'project.ds');
    mkdirSync(project);
    writeFileSync(path.join(project, 'main.ds'), 'application "Dir_Project"\n{\n}\n');
    const app = load(project);
    assert.equal(app.name, 'Dir_Project');
    assert.deepEqual(app.files, ['main.ds']);
    assert.throws(
      () => load(path.join(dir, 'missing.ds')),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const TWO_DELUGE_UNITS = `application "TwoUnits"
{
	functions
	{
		void alpha()
		{
			info "alpha";
		}
		void beta()
		{
			info "beta";
		}
	}
}
`;

const NO_DELUGE_UNITS = `application "NoUnits"
{
	section S
	{
		form Item
		{
			Name
			(
				type = text
			)
		}
	}
}
`;

test('analyze text shows Deluge units and the Catalyst function as separate counts', () => {
  const counts = [TWO_DELUGE_UNITS, NO_DELUGE_UNITS].map((source) => {
    const report = analyze(deriveIr(parse(source)));
    const parsed = JSON.parse(analyzeAsJson(report)) as {
      deluge: { units: number };
      catalyst: { delugeUnits?: number; functions: number };
    };
    const line = analyzeAsText(report)
      .split('\n')
      .find((entry) => entry.startsWith('catalyst (estimate):'));
    assert.ok(line);
    assert.equal(parsed.catalyst.functions, 1);
    assert.equal(parsed.catalyst.delugeUnits, parsed.deluge.units);
    assert.match(line, new RegExp(`deluge units ${parsed.deluge.units}  functions 1`));
    return parsed.deluge.units;
  });
  assert.deepEqual(counts, [2, 0]);
});

/**
 * One report criteria and one named filter that do not translate, plus two
 * functions and one form workflow. The report holes belong to the application.
 * The workflow's toDecimal call is shimmed, so it adds no hole.
 */
const SCOPED = `application "Blocker_Scope"
{
	forms
	{
		form Item
		{
			Title
			(
				type = text
				displayname = "Title"
			)
			Qty
			(
				type = number
				displayname = "Qty"
			)
		}
	}
	reports
	{
		list Gappy
		{
			show all rows from Item [Lookup.Field]
			(
				Title
			)
		}
		list Filtered
		{
			show all rows from Item [Title == "Open"]
			(
				Title
			)
			filters
			{
				"Broken" : Lookup.Field
			}
		}
	}
	workflow
	{
		form
		{
			On_Add as "On add"
			{
				type = form
				form = Item
				on add
				{
					actions
					{
						on success
						(
							info "saved";
							n = toDecimal(input.Qty);
						)
					}
				}
			}
		}
	}
	functions
	{
		Deluge
		{
			void do_one(int id)
			{
				info id;
			}
			void do_two(int id)
			{
				info id;
			}
		}
	}
}
`;

function residualBlockers(report: AnalyzeReport) {
  return report.blockers.filter((blocker) => blocker.kind !== 'feature');
}

function assertCountedOnce(report: AnalyzeReport): void {
  const blockers = residualBlockers(report);
  const listed = blockers.map((blocker) => `${blocker.scope ?? ''}|${blocker.label}|${blocker.detail}`);
  assert.equal(new Set(listed).size, listed.length);
  assert.equal(report.deluge.todo, report.determinism.todoCount);
  assert.equal(report.deluge.todoLocations.length, report.deluge.todo);
  assert.equal(blockers.length, report.determinism.todoCount);
  for (const blocker of blockers) {
    const location = report.deluge.todoLocations.find((item) => item.location === blocker.label && item.construct === blocker.detail);
    assert.equal(blocker.scope, location?.scope);
  }
}

/**
 * A blueprint whose stage and `start` settings blocks carry nested `chart
 * data` blocks and an unsupported property, and whose transition has a phase
 * with an unsupported property (`from port`). Those are source-UI layout
 * metadata: the generator lists each one as a residual hole, so analyze must
 * list each as a blocker too — never a counted TODO with no blocker entry.
 */
const BLUEPRINT_BLOCKS = `application "Blueprint_Blocks"
{
	forms
	{
		form Item
		{
			Title
			(
				type = text
				displayname = "Title"
			)
		}
	}
	workflow
	{
		form
		{
			Flow as "Flow"
			{
				type = blueprint
				form = Item
				start
				{
					start stage = Draft
					theme = dark
					chart data
					{
						x = 1
					}
				}
				stages
				{
					Draft
					{
						displayname = "Draft"
						chart data
						{
							y = 2
						}
					}
					Review
					{
						displayname = "Review"
					}
				}
				transitions
				{
					Send
					{
						from stage = Draft
						to stage = Review
						during
						{
							from port = left
						}
					}
				}
			}
		}
	}
}
`;

test('blueprint stage, start and transition-phase residual holes counted in todoKinds are blockers', () => {
  const report = analyze(deriveIr(parse(BLUEPRINT_BLOCKS)));
  assertCountedOnce(report);
  const blockerDetails = residualBlockers(report).map((blocker) => blocker.detail);
  for (const kind of report.determinism.todoKinds) {
    assert.ok(
      blockerDetails.filter((detail) => detail === kind.construct).length >= kind.count,
      `todoKinds lists ${kind.count} × ${kind.construct} but blockers do not`,
    );
  }
  const constructs = report.determinism.todoKinds.map((kind) => kind.construct);
  assert.ok(constructs.includes('blueprint-stage-block-chart data'));
  assert.ok(constructs.includes('blueprint-start-block-chart data'));
  assert.ok(constructs.includes('blueprint-start-property-theme'));
  const phaseConstruct = 'blueprint-phase-property-from port';
  assert.equal(report.determinism.todoKinds.find((kind) => kind.construct === phaseConstruct)?.count, 1);
  assert.equal(report.deluge.todoLocations.filter((item) => item.construct === phaseConstruct).length, 1);
  assert.equal(residualBlockers(report).filter((blocker) => blocker.detail === phaseConstruct).length, 1);
  for (const construct of constructs) {
    assert.ok(blockerDetails.includes(construct), `blockers is missing ${construct}`);
  }
});

test('app-level report criteria are listed once with scope app', () => {
  const report = analyze(deriveIr(parse(SCOPED)));
  assertCountedOnce(report);
  assert.deepEqual(
    report.deluge.todoLocations,
    [
      { location: 'report Filtered filter Broken', construct: 'report-criteria', scope: 'app' },
      { location: 'report Gappy', construct: 'report-criteria', scope: 'app' },
      {
        location: 'report Gappy',
        construct: 'Filter not migrated: dynamic or unsupported criteria need manual translation; the report returns no rows.',
        scope: 'ui',
      },
      {
        location: 'report Filtered',
        construct: 'Named filter "Broken" is not migrated; selecting it returns no rows.',
        scope: 'ui',
      },
    ],
  );
  assert.equal(report.determinism.todoKinds.find((kind) => kind.construct === 'report-criteria')?.count, 2);
  assert.equal(report.determinism.uiTodoCount, 2);
  assert.equal(report.deluge.todo, 4);
});

test('relative report criteria compile while unsupported relative comparisons fail closed', () => {
  const source = `application "Relative_Report_Criteria"
{
	forms
	{
		form Item
		{
			Added_Time
			(
				type = datetime
			)
		}
	}
	reports
	{
		list This_Week
		{
			show all rows from Item [Added_Time is this week]
			(
				Added_Time
			)
		}
		list This_Month
		{
			show all rows from Item [Added_Time is this month]
			(
				Added_Time
			)
		}
		list Unsupported
		{
			show all rows from Item [Added_Time > this week]
			(
				Added_Time
			)
		}
	}
}
`;
  const report = analyze(deriveIr(parse(source)));
  assert.deepEqual(
    report.deluge.todoLocations.filter((item) => item.location.startsWith('report ')),
    [
      { location: 'report Unsupported', construct: 'report-criteria', scope: 'app' },
      {
        location: 'report Unsupported',
        construct: 'Filter not migrated: dynamic or unsupported criteria need manual translation; the report returns no rows.',
        scope: 'ui',
      },
    ],
  );
  assert.equal(report.determinism.todoCount, 2);
  assert.equal(report.determinism.uiTodoCount, 1);
});

const galleryRoot = process.env.C2C_FIXTURES_DIR;
const galleryDir = galleryRoot ? path.join(galleryRoot, 'gallery') : '';
const gallerySkip = galleryDir ? false : 'C2C_FIXTURES_DIR/gallery is not available';

/**
 * The exact counts below were measured on one export of each app. The gallery
 * drifts as apps are re-exported, so a test runs only while every file it
 * reads still matches the recorded sha256; a different export is skipped with
 * the drifted file named instead of failing on stale expectations.
 */
const GALLERY_SHA256: Record<string, string> = {
  'course-planner/Course_Planner.ds': '7034b5dc8f0f3e5c4442dd3f72c45085a211460b563ecaf9e36718da03d42b4f',
  'customer-relationship-manager/Customer_Relationship_Manager.ds': 'ff2ae9cdfa58519e177109d91d6bda99d1181e7b13e84fb818fc1b5344f3600c',
  'education-management/Education_Management.ds': 'a3189994bf1c7943bfaaceba054bb925635e747ec81b4a7eec1b7d1ac4ef5a46',
  'employee-emergency-check-in/Employee_Emergency_Check_In.ds': '119d3174970cd0c1769ffdd85cd10fdae233c870600352f063f6d23244f0b3bb',
  'employee-management/Employee_Management.ds': 'd63d2c816d7dc2ec97867f8e61f81a0663eec230fe982e2d8a263f4923387e53',
};

function galleryFixtureSkip(...files: string[]): string | false {
  for (const rel of files) {
    const file = path.join(galleryDir, rel);
    let content: Buffer | undefined;
    try {
      content = readFileSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const digest = content ? createHash('sha256').update(content).digest('hex') : undefined;
    if (digest !== GALLERY_SHA256[rel]) {
      return `gallery fixture ${rel} differs from the export these expectations were measured on`;
    }
  }
  return false;
}

function galleryDs(appDir: string, file: string): App {
  return parseFile(path.join(galleryDir, appDir, file)).ir;
}

test(
  'course-planner and CRM blockers match the residual, each app-level hole once',
  { skip: gallerySkip || galleryFixtureSkip('course-planner/Course_Planner.ds', 'customer-relationship-manager/Customer_Relationship_Manager.ds') },
  () => {
  const course = analyze(galleryDs('course-planner', 'Course_Planner.ds'));
  assertCountedOnce(course);
  assert.equal(course.determinism.todoCount, 3);
  assert.equal(course.determinism.uiTodoCount, 1);
  assert.deepEqual(
    course.deluge.todoLocations.filter((item) => item.scope === 'app').map((item) => `${item.location}|${item.construct}`),
    ['report Ongoing_Courses_Student|report-criteria'],
  );
  assert.deepEqual(
    course.deluge.todoLocations.filter((item) => item.scope === 'unit' && item.construct === 'criteria-dynamic'),
    [{ location: 'workflow Run_Scripts_On_Click_of_Y:14', construct: 'criteria-dynamic', scope: 'unit' }],
  );

  const crm = analyze(galleryDs('customer-relationship-manager', 'Customer_Relationship_Manager.ds'));
  assertCountedOnce(crm);
  assert.equal(crm.determinism.todoCount, 7);
  assert.equal(crm.determinism.uiTodoCount, 7);
  assert.deepEqual(
    crm.deluge.todoLocations.filter((item) => item.scope === 'app').map((item) => `${item.location}|${item.construct}`),
    [],
  );
  },
);

test(
  'education, emergency, and management blocker counts agree',
  {
    skip:
      gallerySkip ||
      galleryFixtureSkip(
        'education-management/Education_Management.ds',
        'employee-emergency-check-in/Employee_Emergency_Check_In.ds',
        'employee-management/Employee_Management.ds',
      ),
  },
  () => {
  const education = analyze(galleryDs('education-management', 'Education_Management.ds'));
  assertCountedOnce(education);
  // count() on a record-typed function parameter now translates as record cardinality, removing three method:count and three client-condition-uses-server residuals on this corpus export. The pinned count is 21 (measured on the corpus export).
  assert.equal(education.determinism.todoCount, 21);
  assert.equal(education.deluge.todoLocations.filter((item) => item.scope === 'app').length, 0);
  const registration = education.deluge.todoLocations.filter((item) => item.location.startsWith('workflow Create_record_scripts12:'));
  assert.equal(registration.length, 2);
  assert.equal(new Set(registration.map((item) => item.location)).size, 2);

  const emergency = analyze(galleryDs('employee-emergency-check-in', 'Employee_Emergency_Check_In.ds'));
  assertCountedOnce(emergency);
  assert.deepEqual(emergency.deluge.todoLocations, [
    { location: 'report Open_Crisis_In_Our_Branch', construct: 'report-criteria', scope: 'app' },
    {
      location: 'report Open_Crisis_In_Our_Branch',
      construct: 'Filter not migrated: dynamic or unsupported criteria need manual translation; the report returns no rows.',
      scope: 'ui',
    },
    {
      location: 'page Crisis_View_Page.dspZml',
      construct: 'Server-side Deluge snippet requires manual translation',
      scope: 'ui',
      manualReasons: ['caller-read', 'dynamic-url'],
      manualStep:
        "snippet ZML Snippet on page Crisis_View_Page: It reads records filtered by the signed-in user or by page parameters. Serve those reads from a server route that checks the caller's read grant for each form and field and passes the parameters as bound criteria values. It builds an iframe, embed, or link URL at render time. Rebuild it with a fixed allowlisted destination or a generated form or report route, and encode each dynamic part. Keep this TODO open until the rebuilt section is verified.",
    },
  ]);

  const management = analyze(galleryDs('employee-management', 'Employee_Management.ds'));
  assertCountedOnce(management);
  assert.deepEqual(management.deluge.todoLocations, [
    {
      location: 'page Dashboard.dsp',
      construct: 'Server-side Deluge snippet requires manual translation',
      scope: 'ui',
      manualReasons: ['sanitizer-loss', 'untranslated'],
      manualStep:
        'snippet HTML Snippet on page Dashboard: The sanitizer drops part of its static markup (<style>). Move its CSS and other dropped markup into the app stylesheet or supported components. The compiler stopped at a Deluge construct with no verified translation (island needs manual translation). Rebuild the section with supported components, or translate the construct by hand with a test. Keep this TODO open until the rebuilt section is verified.',
    },
    {
      location: 'page Employee_Profile.dsp',
      construct: 'Server-side Deluge snippet requires manual translation',
      scope: 'ui',
      manualReasons: ['caller-read', 'dynamic-url'],
      manualStep:
        'snippet HTML Snippet on page Employee_Profile: It reads records filtered by the signed-in user or by page parameters. Serve those reads from a server route that checks the caller\'s read grant for each form and field and passes the parameters as bound criteria values. It builds an iframe, embed, or link URL at render time. Rebuild it with a fixed allowlisted destination or a generated form or report route, and encode each dynamic part. Keep this TODO open until the rebuilt section is verified.',
    },
  ]);
  },
);

test('a write-bearing server snippet stays one counted UI blocker with a guided step', () => {
  const app = deriveIr(
    parse(`application "Demo"
{
\tpage Home
\t{
\t\tContent="<zml><layout><panel><dspZml name=\\"Audit\\" value=\\"<% insert into Audit [ Note = &quot;x&quot; ]; %>\\"/></panel></layout></zml>"
\t}
}
`),
  );
  const r = analyze(app);
  assert.equal(r.determinism.uiTodoCount, 1);
  const ui = r.blockers.filter((b) => b.kind === 'ui');
  assert.equal(ui.length, 1);
  assert.equal(ui[0]?.label, 'page Home.dspZml');
  assert.equal(ui[0]?.detail, 'Server-side Deluge snippet requires manual translation');
  assert.equal(ui[0]?.manualReasons?.[0], 'write');
  assert.match(ui[0]?.manualStep ?? '', /^snippet Audit on page Home: It writes during page rendering/);
  assert.match(analyzeAsText(r), /\n {2}ui: page Home\.dspZml \(Server-side Deluge snippet requires manual translation\)\n {4}step: snippet Audit on page Home: /);
});

test('a page holding a server-side Deluge snippet counts one named UI blocker', () => {
  const app = deriveIr(
    parse(`application "Demo"
{
\tpage Home
\t{
\t\tContent="<zml><layout><panel><dspZml name=\\"Snippet\\" value=\\"<% while (x < 1) { z = 1; } %>\\"/></panel></layout></zml>"
\t}
}
`),
  );
  const r = analyze(app);
  assert.equal(r.determinism.uiTodoCount, 1);
  assert.equal(
    r.blockers.filter((b) => (b.kind as string) === 'ui').length,
    1,
    'Each UI stub must be counted EXACTLY once (fails if the dropped loop comes back)',
  );
  assert.ok(
    r.blockers.some(
      (b) => (b.kind as string) === 'ui' && b.label === 'page Home.dspZml' && /manual translation/.test(b.detail),
    ),
    JSON.stringify(r.blockers),
  );
});
