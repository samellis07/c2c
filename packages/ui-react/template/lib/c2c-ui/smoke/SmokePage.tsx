/**
 * The hidden admin smoke page (#/admin/smoke) — never in the nav. It runs the
 * plan the deploy embedded in c2c-config.js through the same guarded
 * endpoints the forms and reports use, with the sign-in this browser already
 * holds. The shell is static; the run fills it imperatively, on the same
 * element contract as the vanilla page — [data-smoke-state], one td per line
 * under [data-smoke-steps], the result code in #c2c-smoke-code beside its
 * Copy button, the sealed block in #c2c-smoke-json — because
 * `c2c smoke --in-browser` polls those attributes and they must not wait on a
 * React commit.
 */
import { useEffect, useRef } from 'react';
import { useEnv } from '../runtime/env';
import { mountSmoke, smokeModel } from './run';

export function SmokePage() {
  const env = useEnv();
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const section = ref.current;
    if (section) mountSmoke(section, smokeModel(env.spec), env.view);
  }, [env]);
  return (
    <section data-smoke ref={ref}>
      <h2>Smoke run</h2>
      <p data-smoke-state="pending">Checking access…</p>
      <div data-smoke-code hidden>
        <p>Paste this into your AI chat (Claude or any LLM):</p>
        <p>
          <code id="c2c-smoke-code" style={{ wordBreak: 'break-all' }} />{' '}
          <button type="button" data-smoke-copy-code>
            Copy
          </button>
        </p>
      </div>
      <table hidden>
        <thead>
          <tr>
            <th>Result</th>
          </tr>
        </thead>
        <tbody data-smoke-steps />
      </table>
      <p data-smoke-copy hidden>
        Using the c2c CLI yourself? Save the block below as smoke-result.txt and run <code>c2c smoke &lt;source&gt; --result smoke-result.txt</code> (or paste it into <code>--result -</code>).
      </p>
      <pre id="c2c-smoke-json" hidden />
    </section>
  );
}
