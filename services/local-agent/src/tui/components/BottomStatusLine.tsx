import { Text } from 'ink';
import {
  formatStatusBarText,
  type StatusBarModel,
} from '../statusBarModel';

export function BottomStatusLine(props: {
  model: StatusBarModel;
  width: number;
}) {
  return (
    <Text dimColor>{formatStatusBarText(props.model, props.width)}</Text>
  );
}
