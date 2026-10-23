import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { SpeedRow } from "../shared/speed";

function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${Math.round(seconds - minutes * 60)} 秒`;
}

export function SpeedRowView({ item, theme }: PluginTimelineItemProps<SpeedRow>) {
  const { tokensPerSecond, outputTokens, generationMs, requests } = item.data;
  return (
    <View style={{ paddingVertical: 4 }}>
      <Text
        accessibilityLabel={`本轮生成速度每秒 ${tokensPerSecond} 个 token`}
        style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}
      >
        {`⚡ ${tokensPerSecond.toFixed(1)} tok/s · 输出 ${outputTokens.toLocaleString("en-US")} tokens · 生成 ${formatDuration(generationMs)} · ${requests} 次请求`}
      </Text>
    </View>
  );
}
