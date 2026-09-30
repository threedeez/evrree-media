import { Inject, Module, type DynamicModule, type ModuleMetadata, type Provider } from '@nestjs/common';
import { createMediaClient, MediaClient } from '../media-client';
import type { MediaClientConfig } from '../types';

/** Injection token for the MediaClient. A registered symbol, so separate copies agree. */
export const MEDIA_CLIENT: unique symbol = Symbol.for('@evrree/media:MEDIA_CLIENT') as never;

/** `constructor(@InjectMedia() private readonly media: MediaClient) {}` */
export const InjectMedia = (): ParameterDecorator & PropertyDecorator => Inject(MEDIA_CLIENT);

export interface MediaModuleOptions extends MediaClientConfig {
  /** Register the module globally. Default true. */
  isGlobal?: boolean;
}

export interface MediaModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  /** Register the module globally. Default true. */
  isGlobal?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inject?: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useFactory: (...args: any[]) => MediaClientConfig | Promise<MediaClientConfig>;
}

@Module({})
export class MediaModule {
  static forRoot(options: MediaModuleOptions): DynamicModule {
    const { isGlobal = true, ...config } = options;
    return MediaModule.build(isGlobal, [], { provide: MEDIA_CLIENT, useValue: createMediaClient(config) });
  }

  static forRootAsync(options: MediaModuleAsyncOptions): DynamicModule {
    return MediaModule.build(options.isGlobal ?? true, options.imports ?? [], {
      provide: MEDIA_CLIENT,
      inject: options.inject ?? [],
      useFactory: async (...args: unknown[]) => createMediaClient(await options.useFactory(...args)),
    });
  }

  private static build(isGlobal: boolean, imports: ModuleMetadata['imports'], clientProvider: Provider): DynamicModule {
    return {
      module: MediaModule,
      global: isGlobal,
      imports: imports ?? [],
      // Also resolvable by class, for apps that use emitDecoratorMetadata type-based injection.
      providers: [clientProvider, { provide: MediaClient, useExisting: MEDIA_CLIENT }],
      exports: [MEDIA_CLIENT, MediaClient],
    };
  }
}

export { MediaClient };
export type { MediaClientConfig };
