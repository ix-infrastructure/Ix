export interface LineItem {
  sku: string;
  price: number;
  quantity: number;
}

export type Listener = (event: string, payload: unknown) => void;
