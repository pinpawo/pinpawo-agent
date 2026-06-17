import { TextAreaView } from './TextAreaView';
import { buildTextAreaViewModel } from '../input/textarea/viewModel';

export function Composer(props: {
  value: string;
  cursorOffset: number;
  placeholder?: string;
  focus?: boolean;
  width?: number;
}) {
  const {
    value,
    placeholder = '',
    focus = true,
    width = 60,
  } = props;
  return (
    <TextAreaView
      model={buildTextAreaViewModel({
        text: value,
        cursorOffset: props.cursorOffset,
        placeholder,
        focused: focus,
        width,
      })}
    />
  );
}
