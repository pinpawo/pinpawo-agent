import { TextAreaView } from './TextAreaView';
import type { TextAreaViewModel } from '../input/textarea/viewModel';

export function Composer(props: {
  model: TextAreaViewModel;
}) {
  return <TextAreaView model={props.model} />;
}
