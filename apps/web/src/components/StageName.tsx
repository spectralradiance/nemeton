import { useSchedule } from '../data/schedule';

/** Stage name with its colour swatch. The name is always shown, so colour is never the only cue. */
export function StageName({ stageId }: { stageId: string }) {
  const stage = useSchedule().stageById.get(stageId);
  return (
    <span className="stage-name" style={stageStyle(stage?.order ?? 0)}>
      {stage?.name ?? stageId}
    </span>
  );
}

const STAGE_COLOURS = 5;

export function stageStyle(order: number): React.CSSProperties {
  return { '--stage': `var(--stage-${order % STAGE_COLOURS})` } as React.CSSProperties;
}
