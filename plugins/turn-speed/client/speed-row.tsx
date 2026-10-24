import { useTranslation, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { SpeedRow } from "../shared/speed";
import { messages } from "./messages";

export function SpeedRowView({ item, theme }: PluginTimelineItemProps<SpeedRow>) {
  const { t, locale } = useTranslation(messages);
  const { tokensPerSecond, outputTokens, generationMs, requests } = item.data;
  const tps = tokensPerSecond.toFixed(1);
  const totalSeconds = generationMs / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const duration =
    minutes > 0
      ? t("minutes", { minutes, seconds: Math.round(totalSeconds - minutes * 60) })
      : t("seconds", { seconds: totalSeconds.toFixed(1) });
  const text = [
    t("speed", { tps }),
    t("output", { count: outputTokens }),
    t("generated", { duration }),
    t("requests", { count: requests }),
  ].join(" · ");
  return (
    <View style={{ paddingVertical: 4 }}>
      <Text
        accessibilityLanguage={locale}
        accessibilityLabel={t("a11y", { tps })}
        style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}
      >
        {text}
      </Text>
    </View>
  );
}
