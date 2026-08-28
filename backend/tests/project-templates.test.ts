import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import jwt from 'jsonwebtoken';
import { uniqueId, req, reqAuth, initTestAuth, JWT_SECRET, authHeaders } from './helpers.ts';

/**
 * Project templates: reusable runtime recipes (image + ports + env) applied
 * at project creation. Covers store CRUD + validation + authorization, plus a
 * real-Docker end-to-end: create a template → bootstrap a project from it →
 * verify env/ports were inherited → clean up.
 */

const createdTemplateIds: string[] = [];
const createdSlugs: string[] = [];

function editorAuth() {
  const token = jwt.sign({ id: 'template-editor-user', username: 'template-editor', role: 'editor', tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
  return { headers: { ...authHeaders(), Authorization: `Bearer ${token}` } };
}

async function cleanupAll(): Promise<void> {
  for (const id of createdTemplateIds) {
    try { await reqAuth('DELETE', `/templates/${id}`); } catch { /* best effort */ }
  }
  for (const slug of createdSlugs) {
    try { await reqAuth('DELETE', `/projects/${slug}`); } catch { /* best effort */ }
  }
}

describe('Project templates (runtime recipes)', () => {
  before(async () => {
    await initTestAuth();
  });

  after(async () => {
    await cleanupAll();
  });

  test('list templates (200, array)', async () => {
    const res = await reqAuth('GET', '/templates');
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.templates));
  });

  test('create a template (201, normalized)', async () => {
    const name = uniqueId('tpl');
    const res = await reqAuth('POST', '/templates', {
      name: `  ${name}  `,
      description: '  Node + Postgres runtime  ',
      defaultName: 'node-pg-app',
      image: 'wsd/workspace:latest',
      ports: [8771, 8771],
      env: { NODE_ENV: 'production', 'bad-key': 'x', '-junk': 'y' },
    });
    assert.strictEqual(res.status, 201, `create: ${res.status}`);
    const data = await res.json();
    createdTemplateIds.push(data.template.id);
    assert.strictEqual(data.template.name, name, 'name should be trimmed');
    assert.strictEqual(data.template.description, 'Node + Postgres runtime');
    assert.deepStrictEqual(data.template.ports, [8771], 'duplicate ports collapse');
    assert.strictEqual(data.template.env.NODE_ENV, 'production');
    assert.strictEqual(data.template.env['bad-key'], undefined, 'invalid env keys are dropped');
    assert.strictEqual(data.template.env['-junk'], undefined);
  });

  test('create a template without a name (400)', async () => {
    const res = await reqAuth('POST', '/templates', { description: 'no name here' });
    assert.strictEqual(res.status, 400);
  });

  test('create a template with a privileged port (400)', async () => {
    const res = await reqAuth('POST', '/templates', { name: uniqueId('tpl-bad'), ports: [80] });
    assert.strictEqual(res.status, 400);
  });

  test('create a template with a reserved Madar port (400)', async () => {
    const res = await reqAuth('POST', '/templates', { name: uniqueId('tpl-bad2'), ports: [3000] });
    assert.strictEqual(res.status, 400);
  });

  test('update a template (explicit fields replace, omitted fields survive)', async () => {
    const name = uniqueId('tpl');
    let res = await reqAuth('POST', '/templates', { name, ports: [8772], env: { KEEP: 'yes' } });
    assert.strictEqual(res.status, 201);
    const created = (await res.json()).template;
    createdTemplateIds.push(created.id);

    // The editor sends the FULL env map it displays — so env replaces entirely.
    res = await reqAuth('PUT', `/templates/${created.id}`, { name: `${name}-v2`, env: { ADD: 'more', KEEP: 'still' } });
    assert.strictEqual(res.status, 200, `update: ${res.status}`);
    const updated = (await res.json()).template;
    assert.strictEqual(updated.name, `${name}-v2`);
    assert.strictEqual(updated.env.KEEP, 'still', 'sent env map fully replaces the old one');
    assert.strictEqual(updated.env.ADD, 'more');
    assert.strictEqual(updated.env.KEEP_OLD, undefined);
    assert.deepStrictEqual(updated.ports, [8772], 'omitted ports survive');
  });

  test('update a missing template (404)', async () => {
    const res = await reqAuth('PUT', '/templates/does-not-exist', { name: 'x' });
    assert.strictEqual(res.status, 404);
  });

  test('delete a template (ok) and a missing one (404)', async () => {
    const name = uniqueId('tpl');
    const res = await reqAuth('POST', '/templates', { name });
    const created = (await res.json()).template;
    createdTemplateIds.push(created.id);

    const del = await reqAuth('DELETE', `/templates/${created.id}`);
    assert.strictEqual(del.status, 200);
    assert.strictEqual((await del.json()).ok, true);
    createdTemplateIds.splice(createdTemplateIds.indexOf(created.id), 1);

    const missing = await reqAuth('DELETE', `/templates/${created.id}`);
    assert.strictEqual(missing.status, 404);
  });

  test('non-admin can read but not write templates (GET 200, write 403)', async () => {
    const get = await req('GET', '/templates', undefined, editorAuth().headers);
    assert.strictEqual(get.status, 200);
    const post = await req('POST', '/templates', { name: uniqueId('tpl-no') }, editorAuth().headers);
    assert.strictEqual(post.status, 403);
    const put = await req('PUT', '/templates/nope', { name: 'x' }, editorAuth().headers);
    assert.strictEqual(put.status, 403);
    const del = await req('DELETE', '/templates/nope', undefined, editorAuth().headers);
    assert.strictEqual(del.status, 403);
  });

  test('bootstrap a real project from a template (inherits env + ports)', async () => {
    const tplName = uniqueId('tpl');
    const tpl = await reqAuth('POST', '/templates', {
      name: tplName,
      defaultName: 'templated-app',
      image: 'wsd/workspace:latest',
      ports: [8771],
      env: { FROM_TEMPLATE: 'yes', NODE_ENV: 'test' },
    });
    assert.strictEqual(tpl.status, 201, `tpl create: ${tpl.status}`);
    const template = (await tpl.json()).template;
    createdTemplateIds.push(template.id);

    const slug = uniqueId('tpl-apply');
    createdSlugs.push(slug);
    const project = await reqAuth('POST', '/projects', {
      name: 'Templated Project',
      slug,
      description: 'booted from a template',
      templateId: template.id,
    });
    assert.strictEqual(project.status, 201, `create from template: ${project.status}`);
    const created = (await project.json()).project;
    assert.strictEqual(created.status, 'running');
    assert.strictEqual(created.env.FROM_TEMPLATE, 'yes', 'template env injected into project');
    assert.strictEqual(created.env.NODE_ENV, 'test');
    assert.ok(created.ports.includes(8771), 'template ports applied');

    // Request-level fields must still win over the template.
    const slug2 = uniqueId('tpl-apply2');
    createdSlugs.push(slug2);
    const override = await reqAuth('POST', '/projects', {
      name: 'Templated Override',
      slug: slug2,
      ports: [8773],
      env: { FROM_TEMPLATE: 'overridden' },
      templateId: template.id,
    });
    assert.strictEqual(override.status, 201, `override create: ${override.status}`);
    const over = (await override.json()).project;
    assert.strictEqual(over.env.FROM_TEMPLATE, 'overridden', 'explicit env wins over template');
    assert.ok(!over.ports.includes(8771), 'explicit ports replace template ports');
    assert.ok(over.ports.includes(8773));
  });

  test('create from a missing template id (404)', async () => {
    const res = await reqAuth('POST', '/projects', {
      name: 'Ghost Template',
      slug: uniqueId('tpl-ghost'),
      templateId: 'template-does-not-exist',
    });
    assert.strictEqual(res.status, 404);
  });
});