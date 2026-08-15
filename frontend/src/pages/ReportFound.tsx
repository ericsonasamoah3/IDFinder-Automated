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
import { Upload, ArrowLeft, Loader2, X, CheckCircle } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { createPageUrl } from "../utils";
import { toast } from "sonner";
import { createFoundID } from "../lib/storage";
import type { IDType } from "../lib/storage";

const PROCESS_URL = import.meta.env.VITE_ID_PROCESS;
const SAVE_URL = import.meta.env.VITE_ID_SAVE;

type FormState = {
  name_on_id: string;
  id_type: IDType | "";
  id_number_hint: string;
  found_location: string;
  finder_name: string;
  finder_contact: string;
  finder_phone: string;
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

export default function ReportFound() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [uploading, setUploading] = useState(false);
  const [photoUrl, setPhotoUrl] = useState<string>("");
  const [imageBase64, setImageBase64] = useState<string>("");

  const [formData, setFormData] = useState<FormState>({
    name_on_id: "",
    id_type: "",
    id_number_hint: "",
    found_location: "",
    finder_name: "",
    finder_contact: "",
    finder_phone: "",
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
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image_base64: base64String,
        }),
      });

      if (!response.ok) {
        throw new Error("Image processing failed");
      }

      const result = await response.json();

      if (result.success) {
        setFormData((prev) => ({
          ...prev,
          name_on_id: result.name_on_id ?? "",
          id_type: result.id_type ?? "",
          id_number_hint: result.id_number_hint ?? "",
        }));

        toast.success("ID details auto-filled!");
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

      // Send image to S3 via Lambda if one was uploaded
      if (imageBase64) {
        const saveResponse = await fetch(SAVE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image_base64: imageBase64,
            form_type: "found",
          }),
        });

        if (!saveResponse.ok) {
          throw new Error("Failed to save image");
        }
      }

      const newReport = await createFoundID({
        name_on_id: data.name_on_id,
        reporter_name: data.finder_name,
        reporter_email: data.finder_contact,
        reporter_phone: data.finder_phone,
        id_type: data.id_type,
        id_number_hint: data.id_number_hint,
        location: data.found_location,
        description: data.description,
      });

      return { newReport };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["foundIDs"] });
      toast.success("Found ID reported successfully!");

      navigate(createPageUrl("Home"));
    },
    onError: () => {
      toast.error("Failed to report found ID. Please try again.");
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
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
          <CardHeader className="bg-forest text-cream border-b-0">
            <CardTitle className="flex items-center gap-3 text-2xl !text-cream">
              <CheckCircle className="h-7 w-7" />
              Report Found ID
            </CardTitle>
            <p className="text-cream/80 mt-2">
              Upload a photo to auto-fill ID details
            </p>
          </CardHeader>

          <CardContent className="p-6">
            <form onSubmit={handleSubmit} className="space-y-5">
              {/* Photo Upload */}
              <div className="space-y-2">
                <div>
                  <Label>ID Photo (Optional)</Label>
                  {uploading && (
                    <p className="text-sm text-forest mt-1 flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Processing...
                    </p>
                  )}
                </div>

                <div className="border-2 border-dashed border-forest/30 rounded-lg p-6 text-center hover:border-forest transition-colors bg-white/40">
                  {photoUrl ? (
                    <div className="relative">
                      <img
                        src={photoUrl}
                        alt="ID Preview"
                        className="w-24 h-24 object-contain mx-auto rounded-lg"
                      />
                      <Button
                        type="button"
                        variant="destructive"
                        size="icon"
                        className="absolute top-2 right-2"
                        onClick={() => {
                          setPhotoUrl("");
                          setImageBase64("");
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

              {/* Name */}
              <div className="space-y-2">
                <Label>Name on ID *</Label>
                <Input
                  required
                  value={formData.name_on_id}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setFormData({ ...formData, name_on_id: e.target.value })
                  }
                  placeholder="Auto-filled from photo"
                />
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
                <Label>Last 4 Digits *</Label>
                <Input
                  value={formData.id_number_hint}
                  maxLength={4}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setFormData({
                      ...formData,
                      id_number_hint: e.target.value,
                    })
                  }
                />
              </div>

              {/* Remaining Fields */}
              <div className="space-y-2">
                <Label>Where You Found It *</Label>
                <Input
                  required
                  value={formData.found_location}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setFormData({
                      ...formData,
                      found_location: e.target.value,
                    })
                  }
                />
              </div>

              <div className="space-y-2">
                <Label>Your Name *</Label>
                <Input
                  required
                  value={formData.finder_name}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setFormData({ ...formData, finder_name: e.target.value })
                  }
                />
              </div>

              {/* Email */}
              <div className="space-y-2">
                <Label>Your Email *</Label>
                <Input
                  type="email"
                  required
                  value={formData.finder_contact}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setFormData({ ...formData, finder_contact: e.target.value })
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
                  value={formData.finder_phone}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setFormData({ ...formData, finder_phone: e.target.value })
                  }
                />
                <p className="text-xs text-ink/50">
                  Used only to text you if the owner is found. Include your country code (e.g. +44 for UK).
                </p>
              </div>

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
                className="w-full bg-forest hover:bg-forest-dark border-forest-dark"
                disabled={reportMutation.isPending || uploading}
              >
                {reportMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Reporting...
                  </>
                ) : (
                  "Report Found ID"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
