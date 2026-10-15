import { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
    const allowIndexing = process.env.NEXT_PUBLIC_ALLOW_INDEXING === "true";
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://wa-akg.app";

    return {
        rules: {
            userAgent: "*",
            allow: allowIndexing ? "/" : "",
            disallow: allowIndexing ? "/dashboard/" : "/",
        },
        sitemap: allowIndexing ? `${baseUrl}/sitemap.xml` : undefined,
    };
}
