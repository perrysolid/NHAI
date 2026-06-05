/**
 * ScoreBreakdown — the composite Authentication Score with a transparent,
 * weighted per-signal breakdown (sub-score x weight = contribution).
 */
import type {ScoreComponent} from '../lib/scoring';

function tone(score: number): 'signal' | 'warn' | 'bad' {
  if (score >= 0.8) return 'signal';
  if (score >= 0.5) return 'warn';
  return 'bad';
}

export default function ScoreBreakdown({
  overall,
  components,
}: {
  overall: number;
  components: ScoreComponent[];
}) {
  const overallTone = overall >= 85 ? 'signal' : overall >= 70 ? 'warn' : 'bad';
  return (
    <div className="score">
      <div className="score__head">
        <div className="score__label">Authentication score</div>
        <div className={`score__value score__value--${overallTone}`}>
          {overall}
          <span className="score__max">/100</span>
        </div>
      </div>
      <div className="score__rows">
        {components.map(c => (
          <div className="srow" key={c.key}>
            <span className="srow__label">{c.label}</span>
            <div className="srow__track">
              <div
                className={`srow__fill srow__fill--${tone(c.score)}`}
                style={{width: `${c.score * 100}%`}}
              />
            </div>
            <span className="srow__w">w {c.weight.toFixed(2)}</span>
            <span className="srow__pts">+{c.contribution.toFixed(0)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
