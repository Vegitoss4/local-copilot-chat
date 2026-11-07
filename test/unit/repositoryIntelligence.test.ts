import * as assert from 'assert';
import * as path from 'path';
import { RepositoryIntelligenceService } from '../../src/services/repositoryIntelligenceService';

describe('Phase 6.2: Repository Intelligence & Code Understanding Suite', () => {
  let intelligenceService: RepositoryIntelligenceService;

  beforeEach(() => {
    intelligenceService = new RepositoryIntelligenceService();
  });

  afterEach(() => {
    intelligenceService.clear();
  });

  it('should extract TypeScript interfaces, types, functions, and imports accurately', () => {
    const tsCode = `
import { UserService, UserRole } from './userService';
import * as path from 'path';

export interface UserProfile {
  id: string;
  name: string;
}

export type UserStatus = 'active' | 'suspended';

export class ProfileController {
  constructor(private service: UserService) {}
}

export async function fetchProfile(id: string): Promise<UserProfile> {
  return { id, name: 'Alice' };
}

const formatName = (first: string, last: string) => \`\${first} \${last}\`;
`;

    const fileIntel = intelligenceService.analyzeAndIndex('C:/Projects/app/src/profile.ts', tsCode);

    assert.strictEqual(fileIntel.extractionMethod, 'ast');
    assert.strictEqual(fileIntel.symbols.length, 5);
    const kinds = fileIntel.symbols.map(s => s.kind);
    assert.ok(kinds.includes('interface'));
    assert.ok(kinds.includes('type'));
    assert.ok(kinds.includes('class'));
    assert.ok(kinds.includes('function'));

    assert.deepStrictEqual(fileIntel.exports, ['UserProfile', 'UserStatus', 'ProfileController', 'fetchProfile']);
    assert.strictEqual(fileIntel.imports.length, 2);
    assert.strictEqual(fileIntel.imports[0].source, './userService');
    assert.deepStrictEqual(fileIntel.imports[0].importedSymbols, ['UserService', 'UserRole']);
  });

  it('should discover dynamic import(...) calls and re-exports in TypeScript AST', () => {
    const code = `
export * from './bridgeService';
export { Helper } from './helperService';

export async function loadLazy() {
  const mod = await import('./lazyPlugin');
  return mod.run();
}
`;
    const fileIntel = intelligenceService.analyzeAndIndex('C:/Projects/app/src/dynamic.ts', code);
    assert.strictEqual(fileIntel.extractionMethod, 'ast');
    assert.strictEqual(fileIntel.imports.length, 3);

    const sources = fileIntel.imports.map(i => i.source);
    assert.ok(sources.includes('./bridgeService'));
    assert.ok(sources.includes('./helperService'));
    assert.ok(sources.includes('./lazyPlugin'));
  });

  it('should parse complex multi-line declarations, enums, class methods, and properties via TypeScript AST', () => {
    const complexTs = `
export enum OrderStatus {
  Pending = 'PENDING',
  Completed = 'COMPLETED'
}

export class OrderManager<T extends { id: string }> {
  public maxOrders: number = 100;

  public async processOrder(
    orderId: string,
    options?: { priority: boolean }
  ): Promise<OrderStatus> {
    return OrderStatus.Completed;
  }
}
`;

    const fileIntel = intelligenceService.analyzeAndIndex('C:/Projects/app/src/orders.ts', complexTs);

    assert.strictEqual(fileIntel.extractionMethod, 'ast');
    assert.ok(fileIntel.exports.includes('OrderStatus'));
    assert.ok(fileIntel.exports.includes('OrderManager'));

    const symbolNames = fileIntel.symbols.map(s => s.name);
    assert.ok(symbolNames.includes('OrderStatus'));
    assert.ok(symbolNames.includes('OrderManager'));
    assert.ok(symbolNames.includes('maxOrders'));
    assert.ok(symbolNames.includes('processOrder'));
  });

  it('should exclude secret, binary, and build files from indexing', () => {
    const secretFile = intelligenceService.analyzeAndIndex('C:/Projects/app/.env.production', 'API_KEY=secret');
    assert.strictEqual(secretFile.symbols.length, 0);

    const buildFile = intelligenceService.analyzeAndIndex('C:/Projects/app/dist/bundle.js', 'function bundle() {}');
    assert.strictEqual(buildFile.symbols.length, 0);
  });

  it('should extract Python classes, functions, methods, and imports', () => {
    const pyCode = `
from os import path, environ
import json

class DatabaseConnection:
    def __init__(self, uri):
        self.uri = uri

    def connect(self):
        pass

def create_connection():
    return DatabaseConnection("sqlite:///:memory:")

def _internal_helper():
    pass
`;

    const fileIntel = intelligenceService.analyzeAndIndex('C:/Projects/app/db.py', pyCode);

    assert.strictEqual(fileIntel.symbols.length, 5);
    const names = fileIntel.symbols.map(s => s.name);
    assert.ok(names.includes('DatabaseConnection'));
    assert.ok(names.includes('__init__'));
    assert.ok(names.includes('connect'));
    assert.ok(names.includes('create_connection'));
    assert.ok(names.includes('_internal_helper'));

    // Check exported symbols exclude private _internal_helper
    assert.ok(fileIntel.exports.includes('DatabaseConnection'));
    assert.ok(fileIntel.exports.includes('create_connection'));
    assert.ok(!fileIntel.exports.includes('_internal_helper'));
  });

  it('should construct incoming and outgoing dependency graph across workspace files', () => {
    const modelsCode = `
export interface Order {
  id: string;
  total: number;
}
`;
    const orderServiceCode = `
import { Order } from './models';

export function calculateTax(order: Order): number {
  return order.total * 0.1;
}
`;
    const checkoutCode = `
import { calculateTax } from './orderService';
import { Order } from './models';

export function checkout(order: Order) {
  return calculateTax(order);
}
`;

    intelligenceService.analyzeAndIndex('C:/Projects/app/models.ts', modelsCode);
    intelligenceService.analyzeAndIndex('C:/Projects/app/orderService.ts', orderServiceCode);
    intelligenceService.analyzeAndIndex('C:/Projects/app/checkout.ts', checkoutCode);

    const graph = intelligenceService.getDependencyGraph();

    const normModels = path.normalize('C:/Projects/app/models.ts').toLowerCase();
    const normOrder = path.normalize('C:/Projects/app/orderService.ts').toLowerCase();
    const normCheckout = path.normalize('C:/Projects/app/checkout.ts').toLowerCase();

    // Outgoing dependencies
    assert.ok(graph.outgoing[normOrder].includes(normModels));
    assert.ok(graph.outgoing[normCheckout].includes(normOrder));
    assert.ok(graph.outgoing[normCheckout].includes(normModels));

    // Incoming dependents (who imports models?)
    assert.ok(graph.incoming[normModels].includes(normOrder));
    assert.ok(graph.incoming[normModels].includes(normCheckout));
  });

  it('should pack high-signal context within specified token budget', () => {
    const modelsCode = `
export interface Item { id: string; price: number; }
export interface Cart { items: Item[]; }
`;
    const cartServiceCode = `
import { Cart, Item } from './models';

export function calculateTotal(cart: Cart): number {
  return cart.items.reduce((acc, item) => acc + item.price, 0);
}
`;
    const controllerCode = `
import { calculateTotal } from './cartService';
`;

    intelligenceService.analyzeAndIndex('C:/Projects/app/models.ts', modelsCode);
    intelligenceService.analyzeAndIndex('C:/Projects/app/cartService.ts', cartServiceCode);
    intelligenceService.analyzeAndIndex('C:/Projects/app/controller.ts', controllerCode);

    const packed = intelligenceService.packContext('C:/Projects/app/cartService.ts', 1000);

    assert.ok(packed.tokensEstimate > 0);
    assert.ok(packed.tokensEstimate <= 1000);
    assert.ok(packed.contextText.includes('File Outline: cartService.ts'));
    assert.ok(packed.contextText.includes('calculateTotal'));
    assert.ok(packed.contextText.includes('Dependency: models.ts'));
    assert.ok(packed.contextText.includes('Cart'));
    assert.ok(packed.contextText.includes('Dependents (files importing this):'));
    assert.ok(packed.contextText.includes('controller.ts'));
  });
});
