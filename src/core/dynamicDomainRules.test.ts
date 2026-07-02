import { describe, expect, it } from 'vitest';
import { buildProductProcurementProfile, formatSelectedSkuLine } from './procurementProfile';

describe('LLM dynamic domain rules', () => {
  it('uses domainRules as the document source instead of mixing generic category filler', () => {
    const product: any = {
      titleRu: 'Сканер штрих-кодов 2D проводной USB X-760E',
      titleCn: '扫码枪',
      priceYuan: 159,
      moq: 1,
      weightKg: null,
      selectedSkuName: 'X-760E · 2D проводной [Профессиональный уровень]',
      selectedSkuPriceYuan: 159,
      skus: [{ name: 'X-760E · 2D проводной [Профессиональный уровень]', priceYuan: 159 }],
      productContext: {
        identity: { domainKind: 'barcode_scanner' },
        procurementProfileDraft: {
          identity: { domainKind: 'barcode_scanner', titleForReport: 'Сканер штрих-кодов 2D проводной USB X-760E', titleForSeo: 'Сканер штрих-кодов 2D USB' },
          domainRules: {
            confidence: 'high',
            buyerMustCheck: [
              'Подтвердите цену выбранного SKU X-760E.',
              'Укажите вес с упаковкой и габариты индивидуальной упаковки.',
              'Подтвердите чтение QR, DataMatrix, EAN и Code128.',
              'Уточните режим USB HID/COM и настройки переключения.',
              'Подтвердите совместимость с Windows, POS и 1C.',
              'Укажите длину USB-кабеля.',
              'Пришлите видео сканирования и фото комплектации.',
            ],
            sampleMustCheck: [
              'Проверить QR, DataMatrix, EAN и Code128.',
              'Проверить режим USB HID.',
              'Проверить режим COM.',
              'Проверить работу в Windows.',
              'Проверить работу с POS/1C.',
              'Проверить маленькие и повреждённые коды.',
              'Проверить кабель и USB-разъём.',
            ],
            cargoMustAsk: [
              'Вес одной единицы с упаковкой.',
              'Габариты индивидуальной упаковки.',
              'Количество в транспортной коробке.',
              'Фото комплектации и коробки.',
              'Наличие CE/FCC/RoHS.',
            ],
            seoAllowedClaims: ['проводной USB-сканер', 'поддержка QR/DataMatrix/EAN/Code128 после подтверждения'],
            seoForbiddenClaims: ['беспроводной', 'Bluetooth', 'профессиональный без подтверждения'],
            redFlags: ['нет видео сканирования', 'не подтверждён HID/COM', 'нет CE/FCC/RoHS'],
            verdictTemplate: 'Можно рассматривать после подтверждения кодов, HID/COM, совместимости и видео сканирования.',
            forbiddenOtherCategoryTerms: ['беспроводной', 'Bluetooth', 'аккумулятор'],
          },
        },
      },
    };

    const profile = buildProductProcurementProfile(product);
    const operational = JSON.stringify([profile.procurement, profile.cargo, profile.content.seoAllowedClaims]).toLowerCase();
    expect(operational).toContain('qr');
    expect(operational).toContain('datamatrix');
    expect(operational).toContain('hid');
    expect(operational).toContain('windows');
    expect(operational).not.toContain('usb устройство');
    expect(operational).not.toContain('электроника');
    expect(formatSelectedSkuLine(profile.identity.productKind, profile.sku, profile.pricing)).not.toMatch(/профессиональн|класс качества/i);
  });
});
