import { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
    // Only generate sitemap if indexing is allowed
    if (process.env.NEXT_PUBLIC_ALLOW_INDEXING !== "true") {
        return [];
    }

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://wa-akg.app";

    return [
        {
            url: baseUrl,
            lastModified: new Date(),
            changeFrequency: "monthly",
            priority: 1,
        },
        {
            url: `${baseUrl}/docs`,
            lastModified: new Date(),
            changeFrequency: "weekly",
            priority: 0.8,
        },
        {
            url: `${baseUrl}/privacy`,
            lastModified: new Date(),
            changeFrequency: "monthly",
            priority: 0.3,
        },
        {
            url: `${baseUrl}/terms`,
            lastModified: new Date(),
            changeFrequency: "monthly",
            priority: 0.3,
        },
    ];
}
