import { PageHeading, PageSubHeading } from "@/components/Typography";

interface PageHeaderProps {
  description?: string;
  title: string;
  video?: unknown;
}

export function PageHeader({ title, description }: PageHeaderProps) {
  return (
    <div>
      <div className="flex flex-col sm:flex-row items-start sm:items-center mt-1 gap-3">
        <div>
          <PageHeading>{title}</PageHeading>
          {description && (
            <PageSubHeading className="mt-1">{description}</PageSubHeading>
          )}
        </div>
      </div>
    </div>
  );
}
