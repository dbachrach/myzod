abstract class Type<T> {
  constructor() {}
  abstract parse(value: unknown): T;
  optional(): UnionType<[Type<T>, UndefinedType]> {
    return new UnionType([this, new UndefinedType()]);
  }
  nullable(): UnionType<[Type<T>, NullType]> {
    return new UnionType([this, new NullType()]);
  }
  and<K extends AnyType>(schema: K): IntersectionType<Type<T>, K> {
    return new IntersectionType(this, schema);
  }
  or<K extends AnyType>(schema: K): UnionType<[Type<T>, K]> {
    return new UnionType([this, schema]);
  }
}

export class ValidationError extends Error {
  name = 'MyZodError';
  path?: (string | number)[];
  constructor(message: string, path?: (string | number)[]) {
    super(message);
    this.path = path;
  }
}

function typeOf(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

function prettyPrintPath(path: (number | string)[]): string {
  return path.reduce<string>((acc, elem, idx) => {
    if (typeof elem === 'number') {
      acc += `[${elem}]`;
    } else if (idx === 0) {
      acc += elem;
    } else {
      acc += '.' + elem;
    }
    return acc;
  }, '');
}

type AnyType = Type<any>;
type Eval<T> = { [K in keyof T]: T[K] } & {};
export type Infer<T extends AnyType> = T extends Type<infer K> ? Eval<K> : any;

// Primitives
class StringType extends Type<string> {
  parse(value: unknown): string {
    if (typeof value !== 'string') {
      throw new ValidationError('expected type to be string but got ' + typeOf(value));
    }
    return value;
  }
}

class BooleanType extends Type<boolean> {
  parse(value: unknown): boolean {
    if (typeof value !== 'boolean') {
      throw new ValidationError('expected type to be boolean but got ' + typeOf(value));
    }
    return value;
  }
}

class NumberType extends Type<number> {
  parse(value: unknown): number {
    if (typeof value !== 'number') {
      throw new ValidationError('expected type to be number but got ' + typeOf(value));
    }
    return value;
  }
}

class UndefinedType extends Type<undefined> {
  parse(value: unknown): undefined {
    if (value !== undefined) {
      throw new ValidationError('expected type to be undefined but got ' + typeOf(value));
    }
    return value;
  }
}

class NullType extends Type<null> {
  parse(value: unknown): null {
    if (value !== null) {
      throw new ValidationError('expected type to be null but got ' + typeOf(value));
    }
    return value;
  }
}

type Literal = string | number | boolean | undefined | null;

class LiteralType<T extends Literal> extends Type<T> {
  constructor(private readonly literal: T) {
    super();
  }
  parse(value: unknown): T {
    if (value !== this.literal) {
      const typeofValue = typeof value !== 'object' ? JSON.stringify(value) : typeOf(value);
      throw new ValidationError(`expected value to be literal ${JSON.stringify(this.literal)} but got ${typeofValue}`);
    }
    return value as T;
  }
}

class UnknownType extends Type<unknown> {
  parse(value: unknown): unknown {
    return value;
  }
}

// Non Primitive types

type InferObjectShape<T> = {
  [key in keyof T]: T[key] extends Type<infer K> ? K : any;
};

type ObjectOptions = {
  allowUnknown?: boolean;
  suppressPathErrMsg?: boolean;
};

class ObjectType<T extends object> extends Type<InferObjectShape<T>> {
  constructor(private readonly objectShape: T, private readonly opts?: ObjectOptions) {
    super();
  }
  parse(value: unknown, optOverrides?: ObjectOptions): InferObjectShape<T> {
    if (typeof value !== 'object') {
      throw new ValidationError('expected type to be object but got ' + typeOf(value));
    }
    if (value === null) {
      throw new ValidationError('expected object but got null');
    }
    if (Array.isArray(value)) {
      throw new ValidationError('expected type to be regular object but got array');
    }
    const keys = Object.keys(this.objectShape);
    const opts = { ...this.opts, ...optOverrides };
    if (!opts.allowUnknown) {
      const illegalKeys = Object.keys(value).filter(x => !keys.includes(x));
      if (illegalKeys.length > 0) {
        throw new ValidationError('unexpected keys on object: ' + JSON.stringify(illegalKeys));
      }
    }
    const acc: any = { ...value };
    for (const key of keys) {
      try {
        const keySchema = (this.objectShape as any)[key];
        if (keySchema instanceof UnknownType && !(value as any).hasOwnProperty(key)) {
          throw new ValidationError(`expected key "${key}" of unknown type to be present on object`);
        }
        if (keySchema instanceof ObjectType) {
          acc[key] = keySchema.parse((value as any)[key], { ...opts, suppressPathErrMsg: true });
        } else if (keySchema instanceof ArrayType) {
          acc[key] = keySchema.parse((value as any)[key], { suppressPathErrMsg: true });
        } else {
          acc[key] = keySchema.parse((value as any)[key]);
        }
      } catch (err) {
        const path = err.path ? [key, ...err.path] : [key];
        const msg = opts.suppressPathErrMsg
          ? err.message
          : `error parsing object at path: "${prettyPrintPath(path)}" - ${err.message}`;
        throw new ValidationError(msg, path);
      }
    }
    return acc;
  }
}

class ArrayType<T extends AnyType> extends Type<Infer<T>[]> {
  constructor(private readonly schema: T) {
    super();
  }
  parse(value: unknown, opts?: { suppressPathErrMsg: boolean }): Infer<T>[] {
    if (!Array.isArray(value)) {
      throw new ValidationError('expected an array but got ' + typeOf(value));
    }
    value.forEach((elem, idx) => {
      try {
        if (this.schema instanceof ObjectType || this.schema instanceof ArrayType) {
          this.schema.parse(elem, { suppressPathErrMsg: true });
        } else {
          this.schema.parse(elem);
        }
      } catch (err) {
        const path = err.path ? [idx, ...err.path] : [idx];
        const msg = opts?.suppressPathErrMsg ? err.message : `error at ${prettyPrintPath(path)} - ${err.message}`;
        throw new ValidationError(msg, path);
      }
    });
    return value;
  }
}

type TupleToUnion<T extends any[]> = T[number];
type InferTupleUnion<T extends AnyType[]> = TupleToUnion<{ [P in keyof T]: T[P] extends Type<infer K> ? K : any }>;
type UnionOptions = { strict?: boolean };

class UnionType<T extends AnyType[]> extends Type<InferTupleUnion<T>> {
  constructor(private readonly schemas: T, private readonly opts?: UnionOptions) {
    super();
  }

  parse(value: unknown): InferTupleUnion<T> {
    const errors: string[] = [];
    for (const schema of this.schemas) {
      try {
        if (this.opts?.strict === false && schema instanceof ObjectType) {
          return schema.parse(value, { allowUnknown: true }) as any;
        }
        return schema.parse(value);
      } catch (err) {
        errors.push(err.message);
      }
    }
    throw new ValidationError('No union satisfied:\n  ' + errors.join('\n  '));
  }
}

class IntersectionType<T extends AnyType, K extends AnyType> extends Type<Infer<T> & Infer<K>> {
  constructor(private readonly left: T, private readonly right: K) {
    super();
  }

  parse(value: unknown): Infer<T> & Infer<K> {
    for (const schema of [this.left, this.right]) {
      // Todo What about unknowns keys of object intersections?
      if (schema instanceof ObjectType) {
        schema.parse(value, { allowUnknown: true });
      } else {
        schema.parse(value);
      }
    }
    return value as any;
  }
}

export const string = () => new StringType();
export const boolean = () => new BooleanType();
export const number = () => new NumberType();
export const unknown = () => new UnknownType();
export const literal = <T extends Literal>(literal: T) => new LiteralType(literal);
export const object = <T extends object>(shape: T, opts?: ObjectOptions) => new ObjectType(shape, opts);
export const array = <T extends AnyType>(type: T) => new ArrayType(type);
export const union = <T extends AnyType[]>(schemas: T, opts?: UnionOptions) => new UnionType(schemas, opts);
export const intersection = <T extends AnyType, K extends AnyType>(l: T, r: K) => new IntersectionType(l, r);

const undefinedValue = () => new UndefinedType();
const nullValue = () => new NullType();
export { undefinedValue as undefined, nullValue as null };

// Support default imports
export default {
  string,
  boolean,
  number,
  unknown,
  literal,
  object,
  array,
  union,
  intersection,
  undefined: undefinedValue,
  null: nullValue,
};
