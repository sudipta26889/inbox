// PAYMENTS DISABLED - all features are free
import { redirect } from "next/navigation";
import { withAuth } from "@/utils/middleware";

export const GET = withAuth("stripe/success", async () => {
  redirect("/setup");
});
