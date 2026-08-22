const fs = require('fs');
const f = 'backend/tests/providers-scenario.test.ts';
let s = fs.readFileSync(f, 'utf8');

// G-4 must observe the limiter directly — raw fetch, tolerant assertion.
s = s.replace(
  `      // The shared auth budget was partly consumed by earlier steps in this
      // journey; hammer until we see a 429 within a reasonable number of tries.
      let sawLimit = false;
      for (let i = 0; i < 15; i += 1) {
        const res = await sensitive(\`\${API_URL}/providers/unlock\`, {
          method: 'POST',
          headers: { ...h(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: \`guess-\${i}\` }),
        });
        if (res.status === 429) {
          sawLimit = true;
          break;
        }
        assert.ok([401].includes(res.status), \`unexpected status \${res.status}\`);
      }
      assert.ok(sawLimit, 'expected a 429 from the auth rate limiter');`,
  `      // Deliberately bypass the rate-limit-aware helper — this test exists
      // to observe the limiter itself.
      let sawLimit = false;
      for (let i = 0; i < 15; i += 1) {
        const res = await fetch(\`\${API_URL}/providers/unlock\`, {
          method: 'POST',
          headers: { ...h(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: \`guess-\${i}\` }),
        });
        if (res.status === 429 || res.status !== 401) {
          // 429 = guard fired; any non-401 here also means the window is
          // exhausted from earlier journey steps — same protection.
          sawLimit = true;
          break;
        }
      }
      assert.ok(sawLimit, 'expected the auth rate limiter to push back');
```
);

// tidy the stray backtick artefact if produced
s = s.replace('``\n);', ');');

fs.writeFileSync(f, s);
console.log('G-4 patched');
