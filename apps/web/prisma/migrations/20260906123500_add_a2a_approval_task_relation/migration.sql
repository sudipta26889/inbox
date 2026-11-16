-- AddForeignKey
ALTER TABLE "a2a_approvals" ADD CONSTRAINT "a2a_approvals_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "a2a_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
