import * as assert from 'assert';
import { ImpactAnalysisService, PlannedFilePatch } from '../../src/services/impactAnalysisService';

describe('Phase 9.4: Multi-File Context & Impact Analysis Suite', () => {
  let impactService: ImpactAnalysisService;

  beforeEach(() => {
    ImpactAnalysisService.resetInstance();
    impactService = ImpactAnalysisService.getInstance();
  });

  it('should identify direct callers and affected test files for a modified symbol', async () => {
    const mockFiles = new Map<string, string>();

    // Target file defining calculateDiscount
    mockFiles.set('c:/project/src/billing/discount.ts', `
      export function calculateDiscount(amount: number, isVip: boolean): number {
        return isVip ? amount * 0.2 : amount * 0.05;
      }
    `);

    // Consumer file 1: checkoutService
    mockFiles.set('c:/project/src/checkout/checkoutService.ts', `
      import { calculateDiscount } from '../billing/discount';
      export class CheckoutService {
        apply(total: number) {
          const discount = calculateDiscount(total, true);
          return total - discount;
        }
      }
    `);

    // Consumer file 2: invoiceGenerator
    mockFiles.set('c:/project/src/invoices/invoiceGenerator.ts', `
      import { calculateDiscount } from '../billing/discount';
      export function makeInvoice(order: any) {
        return calculateDiscount(order.subtotal, false);
      }
    `);

    // Test file: discount.test.ts
    mockFiles.set('c:/project/test/unit/discount.test.ts', `
      import { calculateDiscount } from '../../src/billing/discount';
      describe('discount', () => {
        it('calculates vip discount', () => {
          assert.equal(calculateDiscount(100, true), 20);
        });
      });
    `);

    const report = await impactService.analyzeImpact('calculateDiscount', 'c:/project/src/billing/discount.ts', mockFiles);

    assert.strictEqual(report.targetSymbol, 'calculateDiscount');
    assert.strictEqual(report.targetFile, 'c:/project/src/billing/discount.ts');
    assert.strictEqual(report.directCallers.length, 2, 'Should find 2 direct caller usages');
    assert.strictEqual(report.affectedTests.length, 1, 'Should find 1 test caller usage');
    assert.strictEqual(report.totalCallersCount, 3);

    // Verify recommendations include target, consumers, and tests
    assert.ok(report.recommendedEditFiles.some(f => f.includes('checkoutService.ts')));
    assert.ok(report.recommendedEditFiles.some(f => f.includes('invoiceGenerator.ts')));
    assert.ok(report.recommendedEditFiles.some(f => f.includes('discount.test.ts')));
  });

  it('should build a coordinated multi-file edit set', async () => {
    const mockFiles = new Map<string, string>();
    mockFiles.set('c:/project/src/api.ts', 'export function login(u: string) {}');
    mockFiles.set('c:/project/src/app.ts', 'login("alice");');

    const report = await impactService.analyzeImpact('login', 'c:/project/src/api.ts', mockFiles);
    const patches: PlannedFilePatch[] = [
      { filePath: 'c:/project/src/api.ts', target: 'login(u: string)', replacement: 'login(u: string, remember: boolean)' },
      { filePath: 'c:/project/src/app.ts', target: 'login("alice")', replacement: 'login("alice", true)' }
    ];

    const editSet = impactService.buildEditSet('Add remember boolean parameter to login', report, patches);
    assert.ok(editSet.transactionId.startsWith('tx_'));
    assert.strictEqual(editSet.patches.length, 2);
    assert.strictEqual(editSet.impactReport.totalCallersCount, 1);
  });
});
