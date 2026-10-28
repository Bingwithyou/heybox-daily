import { z } from "zod";

export const sponsorAvatarPath =
  /^\/sponsors\/[a-zA-Z0-9][a-zA-Z0-9_-]*\.(?:jpg|jpeg|png|webp|avif)$/;
export const sponsorsSchema = z.array(
  z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    avatar: z.string().regex(sponsorAvatarPath),
  }),
);
export type SponsorEntry = z.infer<typeof sponsorsSchema>[number];
