import type { PresentedQrisMutation } from './orkut-web-report.service';
export interface AppQrisDetailEnrichment {
    amount: number | null;
    amountNett: number | null;
    brandName: string | null;
    cpan: string | null;
    displayTime: string | null;
    feeText: string | null;
    mid: string | null;
    mpan: string | null;
    nmid: string | null;
    raw: Record<string, unknown>;
    rawId: string;
    rrn: string | null;
    senderName: string | null;
    statusCode: 'IN' | 'OUT';
}
export declare function readPresentedMutationRawId(rawDataJson: string): string;
export declare function enrichPresentedQrisMutationsWithAppDetails(rows: PresentedQrisMutation[], details: AppQrisDetailEnrichment[]): PresentedQrisMutation[];
export declare function mergeRawMutationWithAppDetail(rawDataJson: string, detail: AppQrisDetailEnrichment): string;
