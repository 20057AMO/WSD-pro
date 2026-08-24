/**
 * opencode-studio.test.ts
 * API-level coverage for the Opencode Studio (against the running container):
 *  - preset subagents & skills are baked into the image and listed
 *  - subagent CRUD lifecycle (create → list → get → update → delete → 404)
 *  - skill CRUD lifecycle (create writes <name>/SKILL.md layout)
 *  - kebab-case name validation + traversal rejection
 *  - config GET/PUT roundtrip preserves existing keys, rejects junk
 *
 * Self-cleaning: every item it creates uses a unique zz- prefix and is
 * deleted at the end.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { reqAuth, uniqueId } from './helpers.ts';

let agentName = '';
let skillName = '';

const AGENT_MD = `---
description: Automated test reviewer
mode: subagent
permission:
  edit: deny
---

You review things.
`;

const SKILL_MD = `---
name: PLACEHOLDER
description: A skill created by automated tests
---

Do the thing.
`;

describe('Opencode Studio API', () => {
  after(async () => {
    for (const [kind, name] of [
      ['agents', agentName],
      ['skills', skillName],
    ] as const) {
      if (!name) continue;
      try {
        await reqAuth('DELETE', `/opencode-studio/${kind}/${name}`);
      } catch {}
    }
  });

  test('presets baked into the image are listed', async () => {
    const agents = await reqAuth('GET', '/opencode-studio/agents');
    assert.equal(agents.status, 200);
    const { agents: list } = await agents.json();
    const names = list.map((a: any) => a.name);
    for (const expected of ['code-reviewer', 'security-auditor', 'test-writer', 'wsd-expert']) {
      assert.ok(names.includes(expected), `preset agent '${expected}' present`);
    }
    const codeReviewer = list.find((a: any) => a.name === 'code-reviewer');
    assert.equal(codeReviewer.mode, 'subagent');

    const skills = await reqAuth('GET', '/opencode-studio/skills');
    const { skills: slist } = await skills.json();
    const snames = slist.map((s: any) => s.name);
    for (const expected of ['git-release', 'docker-debug', 'wsd-workflow']) {
      assert.ok(snames.includes(expected), `preset skill '${expected}' present`);
    }
  });

  test('agent CRUD lifecycle', async () => {
    agentName = uniqueId('zz-agent').slice(0, 40);

    const created = await reqAuth('POST', `/opencode-studio/agents/${agentName}`, { content: AGENT_MD });
    assert.equal(created.status, 200);

    const dup = await reqAuth('POST', `/opencode-studio/agents/${agentName}`, { content: AGENT_MD });
    assert.equal(dup.status, 200, 'save is upsert-style (edit in place)');

    const got = await reqAuth('GET', `/opencode-studio/agents/${agentName}`);
    assert.equal(got.status, 200);
    const body = await got.json();
    assert.match(body.content, /You review things\./);

    const listed = await (await reqAuth('GET', '/opencode-studio/agents')).json();
    const found = listed.agents.find((a: any) => a.name === agentName);
    assert.equal(found.description, 'Automated test reviewer');
    assert.equal(found.mode, 'subagent');

    const updated = await reqAuth('POST', `/opencode-studio/agents/${agentName}`, {
      content: AGENT_MD.replace('reviewer', 'auditor'),
    });
    assert.equal(updated.status, 200);
    const reread = await (await reqAuth('GET', `/opencode-studio/agents/${agentName}`)).json();
    assert.ok(reread.content.includes('auditor'));
  });

  test('agent delete removes it', async () => {
    const res = await reqAuth('DELETE', `/opencode-studio/agents/${agentName}`);
    assert.equal(res.status, 200);
    const gone = await reqAuth('GET', `/opencode-studio/agents/${agentName}`);
    assert.equal(gone.status, 404);
    agentName = ''; // already cleaned
  });

  test('skill CRUD lifecycle', async () => {
    skillName = uniqueId('zz-skill').replace(/-/g, '-').slice(0, 40);
    const content = SKILL_MD.replace('PLACEHOLDER', skillName);

    const created = await reqAuth('POST', `/opencode-studio/skills/${skillName}`, { content });
    assert.equal(created.status, 200);

    const listed = await (await reqAuth('GET', '/opencode-studio/skills')).json();
    const found = listed.skills.find((s: any) => s.name === skillName);
    assert.equal(found.description, 'A skill created by automated tests');

    const gone = await reqAuth('DELETE', `/opencode-studio/skills/${skillName}`);
    assert.equal(gone.status, 200);
    const confirm = await reqAuth('GET', `/opencode-studio/skills/${skillName}`);
    assert.equal(confirm.status, 404);
    skillName = '';
  });

  test('invalid names rejected with 400', async () => {
    for (const bad of ['../escape', 'Has-Caps', 'has space']) {
      const res = await reqAuth('GET', `/opencode-studio/agents/${encodeURIComponent(bad)}`);
      assert.equal(res.status, 400, `'${bad}' rejected`);
    }
  });

  test('config roundtrip preserves keys and rejects junk', async () => {
    const before = await (await reqAuth('GET', '/opencode-studio/config')).json();

    const patched = await reqAuth('PUT', '/opencode-studio/config', {
      ...before,
      subagent_depth: 2,
    });
    assert.equal(patched.status, 200);
    const merged = await patched.json();
    assert.equal(merged.$schema, before.$schema, '$schema preserved');
    assert.equal(merged.model, before.model, 'model preserved');
    assert.equal(merged.subagent_depth, 2);

    // Restore original depth value if it existed, else remove our key.
    const restore: Record<string, unknown> = { ...before };
    if (!('subagent_depth' in before)) {
      // PUT merge cannot delete keys; set back to V1 default explicitly.
      restore.subagent_depth = 1;
    }
    await reqAuth('PUT', '/opencode-studio/config', restore);

    const junk = await reqAuth('PUT', '/opencode-studio/config', [1, 2]);
    assert.equal(junk.status, 400);
  });

  test('version endpoint reports a sane shape', async () => {
    const res = await reqAuth('GET', '/opencode-studio/version');
    assert.equal(res.status, 200);
    const v = await res.json();
    assert.ok(typeof v.current === 'string' && v.current.length > 0);
    assert.deepEqual(v.supportedMajors, [1]);
    assert.equal(typeof v.updateRunning, 'boolean');
  });
});
