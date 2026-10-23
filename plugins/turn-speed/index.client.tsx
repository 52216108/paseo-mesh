import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SpeedRowView } from "./client/speed-row";
import { SPEED_ROW_KIND, SPEED_ROW_VERSION, speedRowSchema } from "./shared/speed";

export default function contribute(client: PluginClientContext) {
  client.addTimelineRenderer({
    kind: SPEED_ROW_KIND,
    version: SPEED_ROW_VERSION,
    schema: speedRowSchema,
    Component: SpeedRowView,
  });
  return () => {};
}
