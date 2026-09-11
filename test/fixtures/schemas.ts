import { z } from "zod";
export const Profile = z.object({
	name: z.string(),
	age: z.string().transform(Number),
});
