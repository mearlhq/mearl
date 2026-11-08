import type {
  ElementCommentStyleChanges,
  ElementPickerSelection,
} from '../content-script/elementPicker';

export interface PageElementComment {
  id: string;
  selection: ElementPickerSelection;
  comment: string;
  styleChanges: ElementCommentStyleChanges;
}
