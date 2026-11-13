import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

export function AppWordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 64 / 46;
  return (
    <Svg
      accessibilityLabel="FL"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="32 41 64 46"
    >
      <ThemedPath
        d="M32 41H60V50H41V60H57V69H41V87H32ZM70 41H79V78H96V87H70Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
