-- 产品销售项知识库：首次建表脚本，兼容 PostgreSQL 11+，不依赖扩展。
-- 影响范围：仅 public schema 下的 kb_* 知识库表；不修改评标项目、用户或历史报告。
-- 在目标数据库中执行整个脚本。任一步失败，事务整体回滚。
-- 表已存在时停止，不使用 IF NOT EXISTS 掩盖结构差异。
-- ID 使用稳定字符串，可填写 UUID 或业务编码，由导入方生成。
-- 所有可选字段未知时填 NULL，不填空字符串、xxxx 或虚构的 0。

BEGIN;


CREATE TABLE public.kb_products (
    product_id      text PRIMARY KEY CHECK (btrim(product_id) <> ''),
    product_code    text NOT NULL UNIQUE CHECK (btrim(product_code) <> ''),
    name            text NOT NULL CHECK (btrim(name) <> ''),
    product_line    text,
    department      text,
    owner           text,
    summary         text,
    scenarios       text,
    boundaries      text,
    source_path     text,
    status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'active', 'retired')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.kb_products IS '产品档案；ID 稳定，不随名称或文件路径变化';
COMMENT ON COLUMN public.kb_products.product_code IS '产品标识，例如 iSecure Center；不是展示名称';
COMMENT ON COLUMN public.kb_products.name IS '展示名称，例如综合安防管理平台';
COMMENT ON COLUMN public.kb_products.scenarios IS '经产品负责人确认的适用行业和典型场景';
COMMENT ON COLUMN public.kb_products.boundaries IS '能力边界及需要集成其他产品的部分';
COMMENT ON COLUMN public.kb_products.source_path IS '原始产品 Markdown 路径，例如 wiki/entities/products/aiotpnp.md';

CREATE TABLE public.kb_product_versions (
    product_version_id text PRIMARY KEY CHECK (btrim(product_version_id) <> ''),
    product_id         text NOT NULL REFERENCES public.kb_products(product_id)
                       ON DELETE RESTRICT,
    version            text NOT NULL CHECK (version ~ '^v[0-9]+(\.[0-9]+)*$'),
    status             text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'active', 'retired')),
    effective_date     date,
    source_path        text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_kb_product_version UNIQUE (product_id, version)
);

COMMENT ON COLUMN public.kb_product_versions.version IS '统一使用带 v 的版本号，例如 v1.5.100，避免 1.5.100/v1.5.100 重复';
COMMENT ON COLUMN public.kb_product_versions.source_path IS '版本说明所在的产品页路径；不要求创建独立版本页';

CREATE TABLE public.kb_categories (
    category_id        text PRIMARY KEY CHECK (btrim(category_id) <> ''),
    product_version_id text NOT NULL
                       REFERENCES public.kb_product_versions(product_version_id)
                       ON DELETE RESTRICT,
    name               text NOT NULL CHECK (btrim(name) <> ''),
    sort_order         integer NOT NULL DEFAULT 0,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_kb_category_name UNIQUE (product_version_id, name),
    CONSTRAINT uq_kb_category_version UNIQUE (category_id, product_version_id)
);

COMMENT ON TABLE public.kb_categories IS '版本内导航分类，不需要对应独立 Markdown 页面';

CREATE TABLE public.kb_sale_items (
    sale_item_id       text PRIMARY KEY CHECK (btrim(sale_item_id) <> ''),
    product_version_id text NOT NULL
                       REFERENCES public.kb_product_versions(product_version_id)
                       ON DELETE RESTRICT,
    category_id        text,
    module_code        text,
    name               text NOT NULL CHECK (btrim(name) <> ''),
    description        text,
    specification_md   text,
    unit               text,
    price_type         text NOT NULL DEFAULT 'unknown'
                       CHECK (price_type IN ('fixed', 'formula', 'inquiry', 'unknown')),
    fixed_price        numeric(18, 4) CHECK (fixed_price >= 0),
    currency           text CHECK (currency ~ '^[A-Z]{3}$'),
    pricing_note       text,
    mandatory          boolean,
    authorization_note text,
    prerequisites      text,
    limitations        text,
    dependency_note    text,
    source_path        text,
    source_file        text,
    source_sheet       text,
    source_row         integer CHECK (source_row > 0),
    status             text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'active', 'retired')),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_kb_sale_category_version
        FOREIGN KEY (category_id, product_version_id)
        REFERENCES public.kb_categories(category_id, product_version_id)
        ON DELETE RESTRICT,
    CONSTRAINT ck_kb_sale_fixed_price
        CHECK (price_type <> 'fixed' OR (fixed_price IS NOT NULL AND currency IS NOT NULL)),
    CONSTRAINT ck_kb_sale_nonfixed_price
        CHECK (price_type = 'fixed' OR fixed_price IS NULL)
);

COMMENT ON TABLE public.kb_sale_items IS '某产品某版本下的一项正式销售项；同名跨产品、跨版本分别建记录';
COMMENT ON COLUMN public.kb_sale_items.sale_item_id IS '全局稳定 ID；不可仅用名称或未核实唯一性的模块编码代替';
COMMENT ON COLUMN public.kb_sale_items.module_code IS '原始销售模块编码，允许跨产品和版本重复';
COMMENT ON COLUMN public.kb_sale_items.category_id IS '未知分类允许 NULL；已指定分类必须属于相同产品版本';
COMMENT ON COLUMN public.kb_sale_items.specification_md IS '完整技术规格 Markdown 原文，不能只保存摘要';
COMMENT ON COLUMN public.kb_sale_items.fixed_price IS '固定单价；未知填 NULL，真实免费才填 0';
COMMENT ON COLUMN public.kb_sale_items.currency IS 'ISO 货币代码，例如 CNY；未知填 NULL';
COMMENT ON COLUMN public.kb_sale_items.mandatory IS 'true 必选、false 非必选、NULL 未核实';
COMMENT ON COLUMN public.kb_sale_items.authorization_note IS '授权范围、复用条件、额外授权费用；未知保持未知';
COMMENT ON COLUMN public.kb_sale_items.dependency_note IS '原始依赖说明；未定位目标 ID 时保留在此，不伪造依赖边';
COMMENT ON COLUMN public.kb_sale_items.source_path IS '准确销售项 Markdown 路径；多版本共页时允许重复，不用路径当主键';
COMMENT ON COLUMN public.kb_sale_items.source_row IS '原始 Excel 数据行号，不是 Markdown 证据行号';

CREATE TABLE public.kb_sale_dependencies (
    dependency_id          text PRIMARY KEY CHECK (btrim(dependency_id) <> ''),
    sale_item_id           text NOT NULL
                           REFERENCES public.kb_sale_items(sale_item_id)
                           ON DELETE RESTRICT,
    depends_on_sale_item_id text NOT NULL
                           REFERENCES public.kb_sale_items(sale_item_id)
                           ON DELETE RESTRICT,
    dependency_type        text NOT NULL
                           CHECK (dependency_type IN ('required', 'conditional', 'optional')),
    condition_note         text,
    source_note            text NOT NULL CHECK (btrim(source_note) <> ''),
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_kb_sale_dependency UNIQUE (sale_item_id, depends_on_sale_item_id),
    CONSTRAINT ck_kb_sale_dependency_self CHECK (sale_item_id <> depends_on_sale_item_id),
    CONSTRAINT ck_kb_sale_dependency_condition
        CHECK (dependency_type <> 'conditional' OR
               (condition_note IS NOT NULL AND btrim(condition_note) <> ''))
);

COMMENT ON TABLE public.kb_sale_dependencies IS '经核实的销售项依赖；不表示授权共享或集成兼容';
COMMENT ON COLUMN public.kb_sale_dependencies.source_note IS '依赖依据，例如 Markdown 路径与章节或原始文件位置';

CREATE INDEX ix_kb_versions_status ON public.kb_product_versions(status);
CREATE INDEX ix_kb_categories_order
    ON public.kb_categories(product_version_id, sort_order, category_id);
CREATE INDEX ix_kb_sale_items_browse
    ON public.kb_sale_items(product_version_id, category_id, status);
CREATE INDEX ix_kb_sale_items_module ON public.kb_sale_items(module_code);
CREATE INDEX ix_kb_sale_items_source ON public.kb_sale_items(source_path);
CREATE INDEX ix_kb_dependencies_target
    ON public.kb_sale_dependencies(depends_on_sale_item_id);

CREATE FUNCTION public.kb_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER tr_kb_products_updated BEFORE UPDATE ON public.kb_products
    FOR EACH ROW EXECUTE PROCEDURE public.kb_touch_updated_at();
CREATE TRIGGER tr_kb_versions_updated BEFORE UPDATE ON public.kb_product_versions
    FOR EACH ROW EXECUTE PROCEDURE public.kb_touch_updated_at();
CREATE TRIGGER tr_kb_categories_updated BEFORE UPDATE ON public.kb_categories
    FOR EACH ROW EXECUTE PROCEDURE public.kb_touch_updated_at();
CREATE TRIGGER tr_kb_sale_items_updated BEFORE UPDATE ON public.kb_sale_items
    FOR EACH ROW EXECUTE PROCEDURE public.kb_touch_updated_at();
CREATE TRIGGER tr_kb_dependencies_updated BEFORE UPDATE ON public.kb_sale_dependencies
    FOR EACH ROW EXECUTE PROCEDURE public.kb_touch_updated_at();

COMMIT;

-- 导入顺序：kb_products → kb_product_versions → kb_categories
--           → kb_sale_items → kb_sale_dependencies。
-- 此脚本仅定义业务主数据；发布版本、快照、检索索引及项目引用由应用迁移管理。
-- 执行失败后（事务仍打开时）运行 ROLLBACK 即可，不需要重启服务。
-- 成功后如需撤销首次建表，且确认未导入需要保留的数据，按以下逆序删除。
-- 不使用 DROP SCHEMA ... CASCADE，避免误删其他对象；以下语句默认不执行。
-- BEGIN;
-- DROP TABLE public.kb_sale_dependencies;
-- DROP TABLE public.kb_sale_items;
-- DROP TABLE public.kb_categories;
-- DROP TABLE public.kb_product_versions;
-- DROP TABLE public.kb_products;
-- DROP FUNCTION public.kb_touch_updated_at();
-- COMMIT;
