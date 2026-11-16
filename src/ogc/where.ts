/** A WHERE clause and its values, built one condition at a time (`$1`, `$2`… in the order the values come). */
export class Where {
  readonly conditions: string[] = [];
  readonly params: unknown[] = [];

  /** `$n` for a new value. */
  value(v: unknown): string {
    this.params.push(v);
    return `$${this.params.length}`;
  }

  /** A condition whose placeholders are numbered from `$1` (as `toSql` numbers them), with its values. */
  addNumbered(sql: string, values: readonly unknown[]): void {
    const offset = this.params.length;
    this.conditions.push(`(${sql.replace(/\$(\d+)/g, (_m, n: string) => `$${Number(n) + offset}`)})`);
    this.params.push(...values);
  }

  toString(): string {
    return this.conditions.length ? `WHERE ${this.conditions.join(" AND ")}` : "";
  }
}
