"use client";

import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { FORMAT_TEXT_COMMAND } from "lexical";
import type { LexicalContent } from "./editorial-model";

function FormattingToolbar() {
  const [editor] = useLexicalComposerContext();
  return <div className="editorial-formatting" role="toolbar" aria-label="Форматирование текста">
    <button type="button" onClick={() => { editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold"); editor.focus(); }} aria-label="Полужирный">B</button>
    <button type="button" onClick={() => { editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic"); editor.focus(); }} aria-label="Курсив"><i>I</i></button>
  </div>;
}

type LexicalFieldProps = { label: string; value: LexicalContent | null | undefined } & (
  { readOnly: true; onChange?: never } | { readOnly?: false; onChange: (value: LexicalContent) => void }
);

export function LexicalField({ label, value, onChange, readOnly = false }: LexicalFieldProps) {
  return <div className="editorial-rich-field">
    <span className="editorial-rich-label">{label}</span>
    <LexicalComposer initialConfig={{
      namespace: `control-room-${label}`,
      editorState: value ? JSON.stringify(value) : undefined,
      editable: !readOnly,
      theme: { paragraph: "editorial-paragraph", text: { bold: "editorial-bold", italic: "editorial-italic" } },
      onError: (error: Error) => { throw error; },
    }}>
      {!readOnly ? <FormattingToolbar /> : null}
      <RichTextPlugin
        contentEditable={<ContentEditable className="editorial-content" aria-label={label} />}
        placeholder={<span className="editorial-placeholder">Напишите содержание…</span>}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <HistoryPlugin />
      {!readOnly && onChange ? <OnChangePlugin ignoreSelectionChange onChange={(state) => onChange(state.toJSON() as LexicalContent)} /> : null}
    </LexicalComposer>
  </div>;
}
