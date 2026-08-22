import { JSX } from 'preact';

const PW_LABELS = ['Too short', 'Weak', 'Okay', 'Good', 'Strong'];
const PW_COLORS = ['var(--red)', 'var(--red)', 'var(--yellow)', 'var(--green)', 'var(--green)'];

/** Simple password strength heuristic (0-4): length plus character variety. */
function passwordStrength(pw: string): number {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 6) score += 1;
  if (pw.length >= 10) score += 1;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 1;
  else if (/\d/.test(pw) && pw.length >= 8) score += 1;
  if (/[^A-Za-z0-9]/.test(pw)) score += 1;
  return Math.min(score, 4);
}

/** Live strength meter shown under new-password inputs. */
export function PwMeter({ pw }: { pw: string }): JSX.Element {
  const score = passwordStrength(pw);
  return (
    <div class="pw-meter" title={`Password strength: ${PW_LABELS[score]}`}>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          class={i < Math.max(score, 1) ? 'pw-seg on' : 'pw-seg'}
          style={i < score ? `background:${PW_COLORS[score]}` : undefined}
        />
      ))}
      <span class="pw-label">{PW_LABELS[Math.max(score, 0)]}</span>
    </div>
  );
}
