"use client";
import React, { useCallback, useEffect, useState } from "react";
import { FileRejection, useDropzone } from "react-dropzone";
import { Card, CardContent } from "../ui/card";
import { cn } from "@/lib/utils";
import {
  RenderEmptyState,
  RenderErrorState,
  RenderUploadedState,
  RenderUploadingState,
} from "./Renderstate";
import { toast } from "sonner";
import { v4 as uuidv4 } from "uuid";
import { useConstructUrl } from "@/hooks/use-construct-url";

interface UploaderState {
  id: string | null;
  file: File | null;
  uploading: boolean;
  progress: number;
  key?: string;
  isDeleting: boolean;
  error: boolean;
  objectUrl?: string | null;
  fileType: "image" | "video";
}

interface iAprops {
  value: string;
  onChange?: (value: string) => void;
  fileTypeAccepted: "image" | "video";
}
const Uploader = ({ onChange, value, fileTypeAccepted }: iAprops) => {
  const fileUrl = useConstructUrl(value || "");
  const [fileState, setFileState] = useState<UploaderState>({
    error: false,
    file: null,
    id: null,
    isDeleting: false,
    uploading: false,
    progress: 0,
    fileType: fileTypeAccepted,
    key: value,
    objectUrl: fileUrl,
  });

  async function uploadFile(file: File) {
    setFileState((prev) => ({
      ...prev,
      uploading: true,
      progress: 0,
    }));

    try {
      const presignedResponse = await fetch("/api/s3/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: file.name,
          contentType: file.type,
          size: file.size,
          isImage: fileTypeAccepted === "image" ? true : false,
        }),
      });

      if (!presignedResponse.ok) {
        toast.error("Failed to get upload URL");
        setFileState((prev) => ({
          ...prev,
          uploading: false,
          progress: 0,
          error: true,
        }));
        return;
      }

      const { presignedUrl, key } = await presignedResponse.json();

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const progressComplete = (event.loaded / event.total) * 100;
            setFileState((prev) => ({
              ...prev,
              progress: Math.round(progressComplete),
              uploading: true,
            }));
          }
        };

        xhr.onload = () => {
          if (xhr.status === 200 || xhr.status === 204) {
            setFileState((prev) => ({
              ...prev,
              uploading: false,
              progress: 100,
              key,
            }));
            onChange?.(key);
            toast.success("File uploaded successfully");
            resolve();
          } else {
            reject(new Error(`Upload failed with status ${xhr.status}: ${xhr.responseText}`));
          }
        };

        xhr.onerror = () => reject(new Error("Network error"));

        xhr.open("PUT", presignedUrl);
        xhr.setRequestHeader("Content-Type", file.type);
        xhr.send(file);
      });
    } catch {
      toast.error("Upload failed. Please try again.");
      setFileState((prev) => ({
        ...prev,
        uploading: false,
        progress: 0,
        error: true,
      }));
    }
  }

  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      if (acceptedFiles.length > 0) {
        const file = acceptedFiles[0];

        if (fileState.objectUrl && !fileState.objectUrl.startsWith("http")) {
          URL.revokeObjectURL(fileState.objectUrl);
        }
        setFileState({
          file,
          id: uuidv4(),
          uploading: false,
          isDeleting: false,
          progress: 0,
          error: false,
          objectUrl: URL.createObjectURL(file),
          fileType: fileTypeAccepted,
        });
        uploadFile(file);
      }
    },
    [fileState.objectUrl]
  );

  function rejectedFiles(fileRejection: FileRejection[]) {
    if (!fileRejection || fileRejection.length === 0) return;

    if (fileRejection.some((r) => r.errors[0].code === "too-many-files")) {
      toast.error("You can only upload one file at a time.");
    }

    if (fileRejection.some((r) => r.errors[0].code === "file-too-large")) {
      const maxSizeMB = fileTypeAccepted === "image" ? 5 : 5000;
      toast.error(`File is too large. Max size is ${maxSizeMB}MB.`);
    }
  }

  function renderContent() {
    if (fileState.uploading) {
      return <RenderUploadingState file={fileState.file as File} progress={fileState.progress} />;
    }
    if (fileState.error) return <RenderErrorState />;
    if (fileState.objectUrl && fileState.key) {
      return (
        <RenderUploadedState
          isDeleting={fileState.isDeleting}
          handleRemoveFile={handleRemoveFile}
          previewUrl={fileState.objectUrl}
          fileType={fileState.fileType}
        />
      );
    }
    return <RenderEmptyState isDragActive={false} />;
  }

  useEffect(() => {
    return () => {
      if (fileState.objectUrl && !fileState.objectUrl.startsWith("http")) {
        URL.revokeObjectURL(fileState.objectUrl);
      }
    };
  }, [fileState.objectUrl]);

  useEffect(() => {
    if (value) {
      setFileState((prev) => ({
        ...prev,
        key: value,
        objectUrl: useConstructUrl(value), // must include the key
        fileType: fileTypeAccepted, // ✅ restore type when loading from backend
      }));
    } else {
      // ✅ reset to empty state when no value
      setFileState((prev) => ({
        ...prev,
        file: null,
        id: null,
        key: undefined,
        objectUrl: undefined,
        fileType: fileTypeAccepted,
        progress: 0,
        uploading: false,
        isDeleting: false,
        error: false,
      }));
    }
  }, [value, useConstructUrl]);

  async function handleRemoveFile() {
    if (fileState.isDeleting || !fileState.objectUrl) return;

    try {
      setFileState((prev) => ({
        ...prev,
        isDeleting: true,
      }));

      const response = await fetch("/api/s3/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: fileState.key,
        }),
      });

      if (!response.ok) {
        toast.error("Failed to delete file from storage");
        setFileState((prev) => ({
          ...prev,
          isDeleting: false,
          error: true,
        }));
        return;
      }
      if (fileState.objectUrl && !fileState.objectUrl.startsWith("http")) {
        URL.revokeObjectURL(fileState.objectUrl);
      }
      onChange?.("");

      setFileState((prev) => ({
        file: null,
        isDeleting: false,
        progress: 0,
        objectUrl: undefined,
        error: false,
        fileType: fileTypeAccepted,
        id: null,
        uploading: false,
      }));

      toast.success("File is successfully deleted from storage");
    } catch (error) {
      toast.error("Error while deleting file");
      setFileState((prev) => ({
        ...prev,
        isDeleting: false,
        error: true,
      }));
    }
  }

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: fileTypeAccepted === "video" ? { "video/*": [] } : { "image/*": [] },
    maxFiles: 1,
    multiple: false,
    maxSize: fileTypeAccepted === "image" ? 5 * 1024 * 1024 : 5000 * 1024 * 1024, // 5MB for images, 5GB for videos
    onDropRejected: rejectedFiles,
  });

  return (
    <Card
      {...getRootProps()}
      className={cn(
        "relative w-full mx-auto rounded-2xl shadow-md border-2 border-dashed cursor-pointer transition-all duration-300 bg-background",
        isDragActive
          ? "border-primary bg-primary/5"
          : "border-muted-foreground/40 hover:border-primary/60 hover:bg-muted/5"
      )}
    >
      <CardContent className="flex flex-col items-center justify-center min-h-[220px] sm:min-h-[260px] lg:min-h-[300px] p-8 text-center">
        <input {...getInputProps()} />
        {renderContent()}
      </CardContent>
    </Card>
  );
};

export default Uploader;
