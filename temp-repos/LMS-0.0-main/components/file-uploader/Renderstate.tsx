"use client";
import { cn } from "@/lib/utils";
import { CloudUploadIcon, ImageIcon, Loader2, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import Image from "next/image";
import { Progress } from "../ui/progress";

export function RenderEmptyState({ isDragActive }: { isDragActive: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center text-center p-8 transition-all duration-200">
      <div className="flex items-center justify-center w-16 h-16 rounded-full bg-muted mb-4">
        <CloudUploadIcon
          className={cn("w-7 h-7 text-muted-foreground", isDragActive && "text-primary")}
        />
      </div>

      <p className="text-base font-medium text-foreground mb-1">Drag & Drop your files</p>
      <p className="text-sm text-muted-foreground mb-4">or click below to browse</p>

      <Button
        variant="outline"
        type="button"
        className="rounded-xl px-5 py-2 shadow-sm hover:shadow-md"
      >
        Select File
      </Button>
    </div>
  );
}

export function RenderErrorState() {
  return (
    <div className="flex flex-col items-center justify-center text-center p-8">
      <div className="flex items-center justify-center w-16 h-16 rounded-full bg-destructive/10 mb-4">
        <ImageIcon className="w-7 h-7 text-destructive" />
      </div>

      <p className="text-base font-semibold text-destructive mb-1">Upload Failed</p>
      <p className="text-sm text-muted-foreground mb-4">Something went wrong. Please try again.</p>

      <Button
        type="button"
        variant="destructive"
        className="rounded-xl px-5 py-2 shadow-sm hover:shadow-md"
      >
        Retry
      </Button>
    </div>
  );
}

export function RenderUploadingState({ progress, file }: { progress: number; file: File }) {
  return (
    <div className="flex flex-col items-center justify-center w-full h-64 sm:h-72 lg:h-80 p-6">
      <CloudUploadIcon className="w-10 h-10 text-primary mb-4 animate-bounce" />
      <p className="text-base font-medium text-primary mb-2">Uploading... {progress}%</p>
      <p className="text-sm text-muted-foreground mb-4 truncate max-w-[80%]">{file.name}</p>
      <Progress value={progress} className="w-2/3 h-2" />
    </div>
  );
}

export function RenderUploadedState({
  previewUrl,
  isDeleting,
  handleRemoveFile,
  fileType,
}: {
  previewUrl: string;
  isDeleting: boolean;
  handleRemoveFile: () => void;
  fileType: "image" | "video";
}) {
  return (
    <div className="relative group w-full h-64 sm:h-72 lg:h-80 rounded-xl overflow-hidden shadow-sm bg-muted flex items-center justify-center">
      {fileType === "video" ? (
        <video
          src={previewUrl}
          className="w-full h-full object-contain rounded-xl"
          muted
          loop
          controls
          controlsList="nodownload"
        />
      ) : (
        <Image
          src={previewUrl}
          alt="Uploaded file"
          fill
          className="object-contain rounded-xl"
          unoptimized
        />
      )}

      <Button
        onClick={(e) => {
          e.stopPropagation();
          handleRemoveFile();
        }}
        disabled={isDeleting}
        size="icon"
        variant="destructive"
        className="absolute top-3 right-3 rounded-full shadow-md bg-background/80 hover:bg-destructive text-destructive hover:text-white"
      >
        {isDeleting ? <Loader2 className="animate-spin" /> : <XIcon className="w-4 h-4" />}
      </Button>
    </div>
  );
}
