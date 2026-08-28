import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Upload, ArrowLeft, Loader2, X, AlertCircle } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { createPageUrl } from "../utils";
import { toast } from "sonner";
import { createLostID } from "../lib/storage";
import type { IDType } from "../lib/storage";

const PROCESS_URL = import.meta.env.VITE_ID_PROCESS;
const SAVE_URL = import.meta.env.VITE_ID_SAVE;

type FormState = {
  owner_name: string;
  owner_email: string;
  owner_phone: string;
  id_type: IDType | "";
  id_number_hint: string;
  last_seen_location: string;
  description: string;
};

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

export default function ReportLost() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [uploading, setUploading] = useState(false);
  const [photoUrl, setPhotoUrl] = useState<string>("");
  const [imageBase64, setImageBase64] = useState<string>("");
  // Kept so the raw OCR output can be archived to S3 next to the
  // photo when the report is submitted.
  const [ocrJson, setOcrJson] = useState<unknown>(null);

  const [formData, setFormData] = useState<FormState>({
    owner_name: "",
    owner_email: "",
    owner_phone: "",
    id_type: "",
    id_number_hint: "",
    last_seen_location: "",
    description: "",
  });

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);

    try {
      const dataUrl = await fileToDataUrl(file);
      setPhotoUrl(dataUrl);

      const base64String = dataUrl.split(",")[1];
      setImageBase64(base64String);

      const response = await fetch(PROCESS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_base64: base64String }),
      });

      if (!response.ok) {
        throw new Error("Image processing failed");
      }

      const result = await response.json();

      if (result.success) {
        setFormData((prev) => ({
          ...prev,
          owner_name: result.name_on_id ?? "",
          id_type: result.id_type ?? "",
          id_number_hint: result.id_number_hint ?? "",
        }));

        setOcrJson(result.extracted ?? result);

        if (result.is_government_id === false) {
          toast.warning(
            "That doesn't look like a government ID -- please check the photo."
          );
        } else {
          toast.success("ID details auto-filled!");
        }
      } else {
        toast.error(result.error || "Failed to extract ID details");
      }
    } catch (error) {
      console.error(error);
      toast.error("Image processing failed");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  const reportMutation = useMutation({
    mutationFn: async (data: FormState) => {
      if (!data.id_type) {
        throw new Error("ID type is required");
      }

      // Send image to S3 via Lambda if one was uploaded. The returned key
      // is threaded into the record below -- previously it was discarded,
      // so every uploaded ID photo sat in S3 unlinked to any report.
      let photoKey = "";
      if (imageBase64) {
        const saveResponse = await fetch(SAVE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image_base64: imageBase64,
            form_type: "lost",
            // Drives the S3 filename: lost/<NAME>.jpg and
            // lost/json/<NAME>.json. Taken from the form rather than the OCR
            // result so a correction the user typed is what gets used.
            name_on_id: data.owner_name,
            ocr_json: ocrJson,
          }),
        });

        if (!saveResponse.ok) {
          throw new Error("Failed to save image");
        }

        const saved = await saveResponse.json();
        photoKey = saved.key ?? "";
      }

      const newReport = await createLostID({
        name_on_id: data.owner_name,
        reporter_name: data.owner_name,
        reporter_email: data.owner_email,
        reporter_phone: data.owner_phone,
        id_type: data.id_type,
        id_number_hint: data.id_number_hint,
        location: data.last_seen_location,
        description: data.description,
        photo_key: photoKey,
      });

      return { newReport };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["lostIDs"] });
      toast.success("Lost ID reported successfully!");

      navigate(createPageUrl("Home"));
    },
    onError: () => {
      toast.error("Failed to report lost ID. Please try again.");
    },
  });

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    reportMutation.mutate(formData);
  };

  return (
    <div className="min-h-screen bg-ink py-10">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
        <Link to={createPageUrl("Home")}>
          <Button variant="ghost" className="mb-6 !text-cream">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Home
          </Button>
        </Link>

        <Card className="shadow-xl border-0 overflow-hidden">
          <CardHeader className="bg-rust text-cream border-b-0">
            <CardTitle className="flex items-center gap-3 text-2xl !text-cream">
              <AlertCircle className="h-7 w-7" />
              Report Lost ID
            </CardTitle>
            <p className="text-cream/80 mt-2">
              Upload your ID to auto-fill your details
            </p>
          </CardHeader>

          <CardContent className="p-6">
            <form onSubmit={handleSubmit} className="space-y-5">
              {/* Photo Upload */}
              <div className="space-y-2">
                <div>
                  <Label>ID Photo (Optional)</Label>
                  {uploading && (
                    <p className="text-sm text-rust mt-1 flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Processing...
                    </p>
                  )}
                </div>

                <div className="border-2 border-dashed border-rust/30 rounded-lg p-6 text-center hover:border-rust transition-colors bg-white/40">
                  {photoUrl ? (
                    <div className="relative">
                      <img
                        src={photoUrl}
                        alt="ID Preview"
                        className="w-24 h-24 object-contain rounded-lg"
                      />
                      <Button
                        type="button"
                        variant="destructive"
                        size="icon"
                        className="absolute top-2 right-2"
                        onClick={() => {
                          setPhotoUrl("");
                          setImageBase64("");
                          setOcrJson(null);
                        }}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : (
                    <label htmlFor="photo" className="cursor-pointer">
                      <Upload className="h-12 w-12 text-ink/30 mx-auto mb-3" />
                      <p className="text-sm text-ink/60 mb-2">
                        Click to upload photo
                      </p>
                      <Input
                        id="photo"
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={handleFileUpload}
                        disabled={uploading}
                      />
                    </label>
                  )}
                </div>
              </div>

              {/* Owner Name */}
              <div className="space-y-2">
                <Label>Your Full Name *</Label>
                <Input
                  required
                  value={formData.owner_name}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setFormData({ ...formData, owner_name: e.target.value })
                  }
                />
              </div>

              {/* Email */}
              <div className="space-y-2">
                <Label>Your Email *</Label>
                <Input
                  type="email"
                  required
                  value={formData.owner_email}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setFormData({ ...formData, owner_email: e.target.value })
                  }
                />
              </div>

              {/* Phone */}
              <div className="space-y-2">
                <Label>Your Phone Number *</Label>
                <Input
                  type="tel"
                  required
                  placeholder="+447700900123"
                  value={formData.owner_phone}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setFormData({ ...formData, owner_phone: e.target.value })
                  }
                />
                <p className="text-xs text-ink/50">
                  Used only to text you if a match is found. Include your country code (e.g. +44 for UK).
                </p>
              </div>

              {/* ID Type */}
              <div className="space-y-2">
                <Label>ID Type *</Label>
                <Select
                  value={formData.id_type}
                  onValueChange={(value: string) =>
                    setFormData({ ...formData, id_type: value as IDType })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select ID type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="national_id">National ID</SelectItem>
                    <SelectItem value="drivers_license">
                      Driver&apos;s License
                    </SelectItem>
                    <SelectItem value="passport">Passport</SelectItem>
                    <SelectItem value="student_id">Student ID</SelectItem>
                    <SelectItem value="work_id">Work ID</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Last 4 */}
              <div className="space-y-2">
                <Label>Last 4 of ID Number *</Label>
                <Input
                  required
                  maxLength={4}
                  value={formData.id_number_hint}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setFormData({
                      ...formData,
                      id_number_hint: e.target.value,
                    })
                  }
                />
              </div>

              {/* Location */}
              <div className="space-y-2">
                <Label>Last Seen Location *</Label>
                <Input
                  required
                  value={formData.last_seen_location}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setFormData({
                      ...formData,
                      last_seen_location: e.target.value,
                    })
                  }
                />
              </div>

              {/* Description */}
              <div className="space-y-2">
                <Label>Additional Details</Label>
                <Textarea
                  rows={4}
                  value={formData.description}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      description: e.target.value,
                    })
                  }
                />
              </div>

              <Button
                type="submit"
                className="w-full bg-rust hover:bg-rust-dark border-rust-dark"
                disabled={reportMutation.isPending || uploading}
              >
                {reportMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Reporting...
                  </>
                ) : (
                  "Report Lost ID"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
