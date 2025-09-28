<?php

/*
 * This file is part of blomstra/fontawesome.
 */

namespace Blomstra\FontAwesome;

use Blomstra\FontAwesome\Content\Frontend;
use Flarum\Extend;

return [
    // 前台：仅通过 Frontend 注入（支持 .css 或 .js kit；为空则走本地 v7 all.min.css）
    (new Extend\Frontend('forum'))
        ->content(Frontend::class),

    // 后台：只保留管理端 JS（如有），其余同上
    (new Extend\Frontend('admin'))
        ->js(__DIR__.'/js/dist/admin.js')
        ->content(Frontend::class),

    // 语言包
    new Extend\Locales(__DIR__.'/locale'),

    // 设置：保留 Kit URL（可填 .css 或 .js），type 仅用于是否走 kit
    (new Extend\Settings())
        ->default('blomstra-fontawesome.kitUrl', '')
        ->default('blomstra-fontawesome.type', 'kit'),
];
