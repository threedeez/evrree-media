import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { MEDIA_CLIENT, InjectMedia, MediaClient, MediaModule } from '../../src/nestjs';
import { MediaError } from '../../src';

@Injectable()
class AvatarService {
  constructor(@InjectMedia() readonly media: MediaClient) {}
}

class FakeConfigService {
  get(name: string): string | undefined {
    return ({ MEDIA_PREFIX: 'cbt' } as Record<string, string>)[name];
  }
}

@Module({ providers: [FakeConfigService], exports: [FakeConfigService] })
class FakeConfigModule {}

describe('MediaModule (AC26)', () => {
  it('forRoot provides a MediaClient resolvable with @InjectMedia()', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MediaModule.forRoot({ provider: { type: 'memory' }, keyPrefix: 'app' })],
      providers: [AvatarService],
    }).compile();
    const service = moduleRef.get(AvatarService);
    expect(service.media).toBeInstanceOf(MediaClient);
    expect(service.media.keyPrefix).toBe('app');
    expect(moduleRef.get(MEDIA_CLIENT)).toBe(service.media);
    expect(moduleRef.get(MediaClient)).toBe(service.media);
    const obj = await service.media.upload({ body: 'x', fileName: 'a.txt', contentType: 'text/plain' });
    expect(obj.key.startsWith('app/')).toBe(true);
  });

  it('forRootAsync builds the client from injected config', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        MediaModule.forRootAsync({
          imports: [FakeConfigModule],
          inject: [FakeConfigService],
          useFactory: async (config: FakeConfigService) => ({
            provider: { type: 'memory' },
            keyPrefix: config.get('MEDIA_PREFIX'),
          }),
        }),
      ],
      providers: [AvatarService],
    }).compile();
    expect(moduleRef.get(AvatarService).media.keyPrefix).toBe('cbt');
  });

  it('is global by default and can be scoped', () => {
    expect(MediaModule.forRoot({ provider: { type: 'memory' } }).global).toBe(true);
    expect(MediaModule.forRoot({ provider: { type: 'memory' }, isGlobal: false }).global).toBe(false);
    expect(MediaModule.forRootAsync({ useFactory: () => ({ provider: { type: 'memory' } }), isGlobal: false }).global).toBe(false);
  });

  it('is available in feature modules when global', async () => {
    @Module({ providers: [AvatarService], exports: [AvatarService] })
    class AvatarModule {}
    const moduleRef = await Test.createTestingModule({
      imports: [MediaModule.forRoot({ provider: { type: 'memory' } }), AvatarModule],
    }).compile();
    expect(moduleRef.get(AvatarService).media).toBeInstanceOf(MediaClient);
  });

  it('surfaces invalid config as CONFIG_ERROR', async () => {
    expect(() => MediaModule.forRoot({ provider: { type: 's3' } as never })).toThrow(MediaError);
    const build = Test.createTestingModule({
      imports: [MediaModule.forRootAsync({ useFactory: () => ({ provider: { type: 's3' } as never }) })],
    }).compile();
    await expect(build).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });

  it('uses a registered symbol token', () => {
    expect(MEDIA_CLIENT).toBe(Symbol.for('@evrree/media:MEDIA_CLIENT'));
  });
});
