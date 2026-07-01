import { SpIcon } from './SpIcon';

interface SignatureBoxProps {
  label: string;
}

export function SignatureBox({ label }: SignatureBoxProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-semibold text-[#111827]">{label}</span>
      <div className="flex h-[100px] items-center justify-center rounded-lg border border-dashed border-kukla-border bg-white">
        <SpIcon name="PenLine" className="h-6 w-6 opacity-70" />
      </div>
    </div>
  );
}
