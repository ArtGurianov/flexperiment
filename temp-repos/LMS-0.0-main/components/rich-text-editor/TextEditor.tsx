"use client";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Menubar from "./Menubar";
import TextAlign from "@tiptap/extension-text-align";

const TextEditor = ({ field }: { field: any }) => {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3], // enable H1, H2, H3
        },
      }),
      TextAlign.configure({
        types: ["heading", "paragraph"],
      }),
    ],
    content: field?.value || "Give the full description",
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "min-h-[300px] focus:outline-none p-2 w-full max-w-none text-base",
      },
    },

    onUpdate: ({ editor }) => {
      field.onChange(editor.getHTML());
    },
  });

  if (!editor) return null;

  return (
    <div className="w-full border border-input rounded-lg overflow-hidden dark:bg-input/30">
      <Menubar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
};

export default TextEditor;
