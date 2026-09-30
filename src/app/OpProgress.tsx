import { Show } from "solid-js";
import { formatBytesLong } from "../panel/format";

export interface OpState {
  id: number;
  title: string;
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  current: string;
}

export default function OpProgress(props: { op: OpState; onCancel: () => void }) {
  const pct = () =>
    props.op.bytesTotal > 0
      ? Math.round((100 * props.op.bytesDone) / props.op.bytesTotal)
      : props.op.filesTotal > 0
        ? Math.round((100 * props.op.filesDone) / props.op.filesTotal)
        : 0;
  return (
    <div class="op-progress" role="status">
      <div class="op-title">
        {props.op.title} — {props.op.filesDone}/{props.op.filesTotal}
        <Show when={props.op.bytesTotal > 0}>
          {" "}· {formatBytesLong(props.op.bytesDone)} of {formatBytesLong(props.op.bytesTotal)}
        </Show>
      </div>
      <div class="op-bar">
        <div style={{ width: `${pct()}%` }} />
      </div>
      <div class="op-current">{props.op.current}</div>
      <button type="button" onClick={() => props.onCancel()}>
        Cancel (Esc)
      </button>
    </div>
  );
}
