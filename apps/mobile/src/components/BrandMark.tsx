import Constants from "expo-constants";
import { Image } from "expo-image";
import { msg, T, useMessages } from "gt-react-native";
import { View } from "react-native";

import { AppText as Text } from "./ui/AppText";
import { APP_BRAND_MARK_SOURCE } from "./brandAssets";
import { MOBILE_APP_BASE_NAME, resolveMobileStageLabel } from "../lib/mobileBranding";

const appVariant = Constants.expoConfig?.extra?.appVariant;
const DEFAULT_STAGE_LABEL = resolveMobileStageLabel(appVariant);

export function BrandMark(props: { readonly compact?: boolean; readonly stageLabel?: string }) {
  const m = useMessages();
  const compact = props.compact ?? false;
  const iconSize = compact ? 32 : 44;
  const stageLabel =
    props.stageLabel ??
    (DEFAULT_STAGE_LABEL === "Dev"
      ? m(msg("Dev", { $context: "app release stage badge" }))
      : m(msg("Nightly", { $context: "app release stage badge" })));

  return (
    <View className="flex-row items-center gap-3">
      <Image
        source={APP_BRAND_MARK_SOURCE}
        accessibilityIgnoresInvertColors
        style={{
          width: iconSize,
          height: iconSize,
          borderRadius: compact ? 10 : 14,
        }}
      />
      <View className="gap-1">
        <View className="flex-row items-center gap-2">
          <Text className="text-lg font-t3-bold tracking-[-0.4px] text-foreground">
            {MOBILE_APP_BASE_NAME}
          </Text>
          <View className="rounded-full bg-subtle px-2 py-1">
            <Text className="text-3xs font-t3-bold tracking-[1.1px] uppercase text-foreground-muted">
              {stageLabel}
            </Text>
          </View>
        </View>
        {!compact ? (
          <Text className="text-xs font-medium text-foreground-muted">
            <T>Mobile control surface for your live coding environments</T>
          </Text>
        ) : null}
      </View>
    </View>
  );
}
